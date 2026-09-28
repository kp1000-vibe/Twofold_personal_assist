// One text conversation turn, whatever app it came from. Same brain, same memory, same trust rules as the web chat.
import { admin, clip, Profile } from "./util.ts";
import { Attachment, runAgent } from "./agent.ts";
import { logActivity, performAction } from "./trust.ts";
import { indexText } from "./knowledge.ts";
import { blockedMessage, budgetFor, markActive } from "./plan.ts";
import { Kind, plain, Provider, saveMedia, sendText, typing } from "./channels.ts";

export type Inbound = {
  provider: Provider;
  providerId: string;
  kinds: Kind[]; // channel kinds this message could belong to
  phone: string;
  text: string;
  media: { url: string; mime: string }[];
};

async function appUrl() {
  const { data } = await admin().from("app_settings").select("app_url, text_daily_cap").eq("id", 1).single();
  return { url: data?.app_url ?? "", cap: data?.text_daily_cap ?? 120 };
}

/** Returns false when this provider message was already handled (webhook retry). */
export async function claimEvent(ev: Inbound): Promise<boolean> {
  const { error } = await admin().from("inbound_events").insert({ provider: ev.provider, provider_id: ev.providerId, phone: ev.phone });
  return !error;
}

export async function handleInbound(ev: Inbound) {
  const db = admin();
  const reply = (kind: Kind, text: string) => sendText(kind, ev.phone, text, ev.provider).catch((e) => console.error("reply", e));
  const { url, cap } = await appUrl();

  const { data: channels } = await db.from("channels").select("*").eq("phone", ev.phone).in("kind", ev.kinds);
  const ch = channels?.[0];
  if (!ch) {
    // answer strangers at most twice a day so we never loop with another bot
    const { count } = await db.from("inbound_events").select("id", { count: "exact", head: true })
      .eq("phone", ev.phone).eq("linked", false).gt("created_at", new Date(Date.now() - 86400_000).toISOString());
    if ((count ?? 0) <= 2) await reply(ev.kinds[0], `Hi! This number is not linked to Twofold yet. Sign in and link it in Settings: ${url}/#/settings`);
    return;
  }
  const kind = ch.kind as Kind;
  await db.from("inbound_events").update({ user_id: ch.user_id, linked: true }).eq("provider", ev.provider).eq("provider_id", ev.providerId);
  await db.from("channels").update({ last_inbound_at: new Date().toISOString() }).eq("id", ch.id);

  const { data: profile } = await db.from("profiles").select("*").eq("id", ch.user_id).single();
  if (!profile?.beta_access) return reply(kind, "Your Twofold access is paused. Open the app to check your invite.");

  await markActive(ch.user_id, "text");
  const budget = await budgetFor(profile as Profile);
  const cmd = ev.text.trim().toUpperCase().replace(/[.!]+$/, "");
  if (cmd === "STOP" || cmd === "UNSUBSCRIBE") {
    await db.from("channels").update({ notify: false }).eq("id", ch.id);
    return; // carriers send their own opt out confirmation
  }
  if (cmd === "START" || cmd === "UNSTOP") {
    await db.from("channels").update({ notify: true }).eq("id", ch.id);
    return reply(kind, "Welcome back. Alerts are on again.");
  }
  if (cmd === "HELP") {
    return reply(kind, `Twofold here. Text me anything, send a photo or PDF, or ask me to draft an email.\nReply YES to approve a draft, NO to skip it, STOP to pause alerts.\nApp: ${url}`);
  }

  // YES / NO / YES 2 act on the drafts listed in the last reply
  const decision = cmd.match(/^(YES|Y|SEND|APPROVE|NO|N|SKIP|CANCEL)(?:\s+(\d))?$/);
  if (decision && ch.pending_actions?.length) {
    const idx = Math.max(0, Number(decision[2] ?? 1) - 1);
    const id = ch.pending_actions[idx];
    const { data: action } = id ? await db.from("actions").select("*").eq("id", id).eq("user_id", ch.user_id).maybeSingle() : { data: null };
    if (!action || !["pending", "scheduled"].includes(action.status)) {
      await db.from("channels").update({ pending_actions: [] }).eq("id", ch.id);
      return reply(kind, "That one was already handled. Nothing else is waiting.");
    }
    const yes = /^(YES|Y|SEND|APPROVE)$/.test(decision[1]);
    const left = ch.pending_actions.filter((x: string) => x !== id);
    await db.from("channels").update({ pending_actions: left }).eq("id", ch.id);
    const more = left.length ? `\n\n${left.length} more waiting. Reply YES or NO for the next one.` : "";
    if (!yes) {
      const status = action.status === "scheduled" ? "undone" : "rejected";
      await db.from("actions").update({ status, decided_at: new Date().toISOString() }).eq("id", action.id);
      await logActivity({ user_id: ch.user_id, kind: status === "undone" ? "undone" : "discarded", title: `${status === "undone" ? "Cancelled" : "Discarded"}: ${action.title}`, why: `You said no by ${kind}`, ref_type: "action", ref_id: action.id });
      return reply(kind, `Skipped: ${action.title}${more}`);
    }
    try {
      await performAction(profile as Profile, action, undefined, `you approved it by ${kind}`);
      const done = action.kind === "create_event" ? "Added to your calendar" : action.kind === "concierge" ? "Marked done" : "Sent";
      return reply(kind, `${done}: ${action.title}${more}`);
    } catch (e) {
      return reply(kind, `Could not do it: ${e instanceof Error ? e.message : String(e)}. You can fix it in the app: ${url}/#/approvals`);
    }
  }

  // daily cap keeps one account from running up the bill
  const { count: today } = await db.from("messages").select("id", { count: "exact", head: true })
    .eq("user_id", ch.user_id).eq("role", "user").not("meta->>channel", "is", null)
    .gt("created_at", new Date(Date.now() - 86400_000).toISOString());
  if (budget.level === "blocked") return reply(kind, blockedMessage(budget, url));
  if ((today ?? 0) >= Math.min(cap, budget.textDailyCap)) return reply(kind, `You hit today's text limit. Keep going in the app: ${url}`);

  await typing(ev.provider, ev.phone);
  const attachments: Attachment[] = [];
  for (const m of ev.media.slice(0, 3)) {
    const saved = await saveMedia(profile as Profile, m.url, m.mime, ev.provider).catch(() => null);
    if (saved) attachments.push(saved);
  }
  const text = clip(ev.text.trim(), 4000) || (attachments.length ? "Please look at the attached file." : "");
  if (!text) return;

  const { data: userMsg } = await db.from("messages").insert({
    user_id: ch.user_id, role: "user", content: text,
    meta: { channel: kind, ...(attachments.length ? { attachments: attachments.map((a) => ({ name: a.name, mime: a.mime })) } : {}) },
  }).select("id").single();
  const { data: history } = await db.from("messages").select("role, content").eq("user_id", ch.user_id).order("created_at", { ascending: false }).limit(11);
  const past = (history ?? []).slice(1).reverse();

  let answer: string;
  let meta: Record<string, any> = {};
  try {
    const out = await runAgent(profile as Profile, text, { purpose: "text", channel: kind, attachments, history: past, lite: budget.level === "lite" });
    answer = out.reply;
    meta = out.meta;
  } catch (e) {
    console.error("text agent", e);
    return reply(kind, "Sorry, I hit a snag on that one. Try again in a minute.");
  }
  const { data: saved } = await db.from("messages").insert({ user_id: ch.user_id, role: "assistant", content: answer, meta: { ...meta, channel: kind } }).select("id").single();

  // list anything that needs a yes, so they can approve right in the thread
  let tail = "";
  const ids: string[] = (meta.actions as string[]) ?? [];
  if (ids.length) {
    const { data: acts } = await db.from("actions").select("id, kind, title, status, payload").in("id", ids);
    const waiting = (acts ?? []).filter((a) => a.status === "pending" || a.status === "scheduled");
    if (waiting.length) {
      await db.from("channels").update({ pending_actions: waiting.map((a) => a.id) }).eq("id", ch.id);
      const a = waiting[0];
      const p = a.payload ?? {};
      const preview = a.kind === "send_email" || a.kind === "cancel_subscription"
        ? `To: ${p.to}\nSubject: ${p.subject}\n\n${clip(p.body, 600)}`
        : a.kind === "create_event" ? `${p.summary}\n${p.start} to ${p.end}${p.location ? `\n${p.location}` : ""}` : clip(a.title, 200);
      tail = a.status === "scheduled"
        ? `\n\n⏱ Going ahead in 5 min unless you reply NO:\n${preview}`
        : `\n\n✉️ Draft ready:\n${preview}\n\nReply YES to ${a.kind === "create_event" ? "add it" : a.kind === "concierge" ? "mark it done" : "send"}, NO to skip, or edit it in the app.`;
      if (waiting.length > 1) tail += ` (${waiting.length - 1} more after this)`;
    }
  }
  const sources = (meta.sources as { url: string }[] | undefined)?.slice(0, 2).map((s) => s.url).join("\n");
  await reply(kind, plain(answer) + tail + (sources ? `\n\nSources:\n${sources}` : ""));

  if (userMsg) await indexText(ch.user_id, "message", userMsg.id, `User said: ${text}`);
  if (saved && answer.length > 60) await indexText(ch.user_id, "message", saved.id, `Assistant replied: ${answer}`);
}
