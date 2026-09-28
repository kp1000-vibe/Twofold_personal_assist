// Trust layer: the user's own rules decide what can happen without asking.
// Every side effect goes through here, gets logged with a reason, and keeps an undo recipe when one exists.
import { admin, HttpError, Profile } from "./util.ts";
import { jev, noul } from "./ai.ts";
import { accessToken, calendarDelete, calendarInsert, gmailSend } from "./google.ts";
import { pushTo } from "./push.ts";
import { textUser } from "./channels.ts";

export const UNDO_WINDOW_MIN = 5;

export async function logActivity(row: {
  user_id: string; kind: string; title: string; why?: string | null;
  ref_type?: string; ref_id?: string; undo?: Record<string, unknown> | null;
}) {
  const { error } = await admin().from("activity").insert(row);
  if (error) console.error("activity", error.message);
}

const THRESHOLD: Record<string, number> = { quiet: 2.5, balanced: 1.5, chatty: 0.5 };

/**
 * Every alert carries a "why now". Silent mode: alerts below the user's interrupt level
 * are kept quietly (shown in Today and the brief) instead of buzzing them.
 */
export async function notify(row: {
  user_id: string; title: string; body?: string | null; link?: string; why: string; importance?: number;
  /** fuller text for iMessage, SMS or WhatsApp; defaults to title plus body */
  text?: string;
}) {
  const importance = row.importance ?? 2;
  const { data: p } = await admin().from("profiles").select("interrupt_level").eq("id", row.user_id).maybeSingle();
  const quiet = importance < (THRESHOLD[p?.interrupt_level ?? "balanced"] ?? 1.5);
  const { text, ...dbRow } = row;
  const { error } = await admin().from("notifications").insert({ ...dbRow, importance, quiet });
  if (error) console.error("notify", error.message);
  if (!quiet) {
    await pushTo(row.user_id, { title: row.title, body: row.body ?? row.why, link: row.link });
    await textUser(row.user_id, text ?? `${row.title}${row.body ? `\n${row.body}` : ""}`);
  }
}

type NewAction = {
  user_id: string; kind: "send_email" | "create_event" | "concierge" | "cancel_subscription";
  title: string; summary?: string | null; payload: Record<string, unknown>;
  source?: string; source_ref?: string;
};

/**
 * Queue an action. Jev checks it against the user's rules:
 * a matching "never" blocks it, a matching "ask" keeps it for approval,
 * a matching "auto" schedules it with a short undo window. No rule means ask.
 */
export async function queueAction(a: NewAction, opts: { upsert?: boolean; forceAsk?: boolean } = {}): Promise<{ id: string | null; status: string; why: string | null }> {
  const db = admin();
  let status = "pending";
  let why: string | null = null;
  let policyId: string | null = null;

  const canAuto = (a.kind === "send_email" || a.kind === "create_event") &&
    !/\[[^\]]{2,}\]/.test(String(a.payload.body ?? ""));

  const { data: rules } = await db.from("policies").select("id, rule, applies_to, mode")
    .eq("user_id", a.user_id).eq("enabled", true).in("applies_to", ["any", a.kind]).limit(40);

  if (rules?.length) {
    const p = a.payload;
    const state = {
      action: a.kind === "send_email"
        ? { type: "email", to: p.to, cc: p.cc, subject: p.subject, body: String(p.body ?? "").slice(0, 1500) }
        : a.kind === "create_event"
        ? { type: "calendar event", title: p.summary, start: p.start, end: p.end, location: p.location, attendees: p.attendees }
        : { type: a.kind, title: a.title, summary: a.summary },
    };
    const qs: Record<string, any> = {};
    rules.forEach((r, i) => {
      qs[`r${i}`] = { type: "noul", instructions: { rule: r.rule, question: "Does `action` fall under `rule`?" } };
    });
    const { answers } = await jev(a.user_id, "policy_check", state, qs);
    const hits = rules.filter((_, i) => noul(answers, `r${i}`) > 0.85);
    const never = hits.find((r) => r.mode === "never");
    const ask = hits.find((r) => r.mode === "ask");
    const auto = hits.find((r) => r.mode === "auto");
    if (never) {
      status = "rejected"; policyId = never.id; why = `Blocked by your rule: ${never.rule}`;
    } else if (ask) {
      policyId = ask.id; why = `Waiting for you because of your rule: ${ask.rule}`;
    } else if (auto && canAuto && !opts.forceAsk) {
      status = "scheduled"; policyId = auto.id; why = `Allowed by your rule: ${auto.rule}`;
    }
  }

  const row = {
    ...a,
    status,
    why,
    policy_id: policyId,
    execute_after: status === "scheduled" ? new Date(Date.now() + UNDO_WINDOW_MIN * 60_000).toISOString() : null,
    decided_at: status === "rejected" ? new Date().toISOString() : null,
  };
  const q = opts.upsert
    ? db.from("actions").upsert(row, { onConflict: "user_id,source_ref", ignoreDuplicates: true }).select("id").maybeSingle()
    : db.from("actions").insert(row).select("id").single();
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const id = data?.id ?? null;
  if (!id) return { id: null, status: "duplicate", why: null };

  if (status === "rejected") {
    await logActivity({ user_id: a.user_id, kind: "blocked", title: `Did not do: ${a.title}`, why, ref_type: "action", ref_id: id });
  } else if (status === "scheduled") {
    await logActivity({ user_id: a.user_id, kind: "scheduled", title: `Will do in ${UNDO_WINDOW_MIN} min: ${a.title}`, why, ref_type: "action", ref_id: id, undo: { type: "cancel_action", action_id: id } });
    await notify({ user_id: a.user_id, title: `Going ahead in ${UNDO_WINDOW_MIN} min: ${a.title}`, body: "Tap to cancel", link: "#/approvals", why: why!, importance: 2, text: `Going ahead in ${UNDO_WINDOW_MIN} min: ${a.title}\n${why}\nTo stop it, open Approvals in the app and tap Cancel.` });
  }
  return { id, status, why };
}

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
function cleanList(v: unknown): string {
  return String(v ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean).join(", ");
}
function allEmails(list: string): boolean {
  return list.split(",").map((s) => s.trim().replace(/^.*<([^>]+)>$/, "$1")).every((s) => EMAIL_RE.test(s));
}

/** Carry out one action. Used for user approvals and for rule approved actions once their undo window passes. */
export async function performAction(profile: Profile, action: any, edits?: Record<string, unknown>, via = "you approved it") {
  const db = admin();
  const payload = { ...action.payload };
  if (edits && typeof edits === "object") {
    for (const k of ["to", "cc", "subject", "body", "summary", "start", "end", "location", "description"]) {
      if (typeof edits[k] === "string") payload[k] = edits[k];
    }
  }
  let result: Record<string, unknown> = {};
  const why = action.why && via !== "you approved it" ? action.why : `Done because ${via}`;
  try {
    if (action.kind === "send_email" || action.kind === "cancel_subscription") {
      const to = cleanList(payload.to);
      const cc = cleanList(payload.cc);
      if (!to || !allEmails(to) || (cc && !allEmails(cc))) throw new HttpError(400, "Check the email addresses");
      if (!String(payload.body ?? "").trim()) throw new HttpError(400, "The email is empty");
      if (/\[[^\]]{2,}\]/.test(String(payload.body))) throw new HttpError(400, "Fill in the [bracketed] parts before sending");
      const token = await accessToken(profile.id);
      if (!token) throw new HttpError(400, "Connect Google in Settings first");
      const sent = await gmailSend(token, {
        to, cc: cc || undefined, subject: String(payload.subject ?? ""), body: String(payload.body),
        threadId: payload.thread_id ?? undefined, inReplyTo: payload.in_reply_to ?? undefined,
      });
      result = { gmail_id: sent.id };
      if (action.kind === "cancel_subscription" && payload.subscription_id) {
        await db.from("subscriptions").update({ status: "cancel_requested" }).eq("id", payload.subscription_id).eq("user_id", profile.id);
      }
      if (action.source_ref?.startsWith("reply:")) {
        await db.from("emails").update({ status: "handled" }).eq("user_id", profile.id).eq("gmail_id", action.source_ref.slice(6));
      }
      await logActivity({ user_id: profile.id, kind: "email_sent", title: `Sent email to ${to}: ${payload.subject ?? ""}`, why, ref_type: "action", ref_id: action.id });
    } else if (action.kind === "create_event") {
      const token = await accessToken(profile.id);
      if (!token) throw new HttpError(400, "Connect Google in Settings first");
      const ev = await calendarInsert(token, {
        summary: payload.summary, start: payload.start, end: payload.end, timezone: payload.timezone ?? profile.timezone,
        location: payload.location ?? undefined, description: payload.description ?? undefined, attendees: payload.attendees ?? [],
      });
      result = { event_id: ev.id, link: ev.htmlLink };
      await logActivity({ user_id: profile.id, kind: "event_created", title: `Added to calendar: ${payload.summary}`, why, ref_type: "action", ref_id: action.id, undo: { type: "delete_event", event_id: ev.id } });
    } else if (action.kind === "concierge") {
      result = { marked_done: true };
      await logActivity({ user_id: profile.id, kind: "errand_done", title: `Errand done: ${action.title}`, why, ref_type: "action", ref_id: action.id });
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("actions").update({ status: "failed", decided_at: new Date().toISOString(), result: { error: msg }, payload }).eq("id", action.id);
    await logActivity({ user_id: profile.id, kind: "failed", title: `Could not finish: ${action.title}`, why: msg, ref_type: "action", ref_id: action.id });
    throw new HttpError(502, `Could not finish: ${msg}`);
  }
  await db.from("actions").update({ status: "done", decided_at: new Date().toISOString(), result, payload }).eq("id", action.id);
  return result;
}

/** Reverse one logged activity when it has an undo recipe. */
export async function undoActivity(profile: Profile, activityId: string) {
  const db = admin();
  const { data: act } = await db.from("activity").select("*").eq("id", activityId).eq("user_id", profile.id).maybeSingle();
  if (!act) throw new HttpError(404, "Not found");
  if (act.undone_at) throw new HttpError(409, "Already undone");
  const u = act.undo as Record<string, string> | null;
  if (!u) throw new HttpError(400, "This one cannot be undone. Sent emails cannot be pulled back.");
  if (u.type === "cancel_action") {
    const { data: a } = await db.from("actions").select("status").eq("id", u.action_id).eq("user_id", profile.id).maybeSingle();
    if (!a || a.status !== "scheduled") throw new HttpError(409, "Too late, it already went out");
    await db.from("actions").update({ status: "undone", decided_at: new Date().toISOString() }).eq("id", u.action_id);
  } else if (u.type === "delete_event") {
    const token = await accessToken(profile.id);
    if (!token) throw new HttpError(400, "Connect Google first");
    await calendarDelete(token, u.event_id);
  } else if (u.type === "delete_task") {
    await db.from("tasks").delete().eq("id", u.id).eq("user_id", profile.id);
  } else if (u.type === "delete_memory") {
    await db.from("memories").delete().eq("id", u.id).eq("user_id", profile.id);
  } else if (u.type === "delete_rule") {
    await db.from("policies").delete().eq("id", u.id).eq("user_id", profile.id);
  } else {
    throw new HttpError(400, "Unknown undo");
  }
  await db.from("activity").update({ undone_at: new Date().toISOString() }).eq("id", act.id);
  await logActivity({ user_id: profile.id, kind: "undone", title: `Undid: ${act.title}`, why: "You asked to undo it" });
  return { ok: true };
}

/** Run rule approved actions whose undo window has passed. Called by the 5 minute job. */
export async function runScheduled() {
  const db = admin();
  const { data: due } = await db.from("actions").select("*").eq("status", "scheduled")
    .lte("execute_after", new Date().toISOString()).limit(50);
  let done = 0;
  for (const a of due ?? []) {
    const { data: claimed } = await db.from("actions").update({ status: "pending" }).eq("id", a.id).eq("status", "scheduled").select("id").maybeSingle();
    if (!claimed) continue;
    const { data: profile } = await db.from("profiles").select("*").eq("id", a.user_id).single();
    try {
      await performAction(profile as Profile, a, undefined, "your rule allowed it");
      done++;
    } catch (e) {
      console.error("scheduled action", a.id, e);
    }
  }
  return done;
}
