// The only place side effects happen, and only after the user taps approve.
import { admin, handle, HttpError, json, requireUser } from "../shared/util.ts";
import { accessToken, calendarInsert, gmailSend } from "../shared/google.ts";

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
function cleanList(v: unknown): string {
  return String(v ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean).join(", ");
}
function allEmails(list: string): boolean {
  return list.split(",").map((s) => s.trim().replace(/^.*<([^>]+)>$/, "$1")).every((s) => EMAIL_RE.test(s));
}

export default handle(async (req) => {
  const profile = await requireUser(req);
  const { action_id, decision, edits } = await req.json();
  if (!action_id || !["approve", "reject"].includes(decision)) throw new HttpError(400, "Bad request");
  const db = admin();
  const { data: action } = await db.from("actions").select("*").eq("id", action_id).eq("user_id", profile.id).maybeSingle();
  if (!action) throw new HttpError(404, "Not found");
  if (action.status !== "pending") throw new HttpError(409, "Already handled");

  if (decision === "reject") {
    await db.from("actions").update({ status: "rejected", decided_at: new Date().toISOString() }).eq("id", action.id);
    return json({ ok: true, status: "rejected" });
  }

  const payload = { ...action.payload };
  if (edits && typeof edits === "object") {
    for (const k of ["to", "cc", "subject", "body", "summary", "start", "end", "location", "description"]) {
      if (typeof edits[k] === "string") payload[k] = edits[k];
    }
  }

  let result: Record<string, unknown> = {};
  try {
    if (action.kind === "send_email" || action.kind === "cancel_subscription") {
      const to = cleanList(payload.to);
      const cc = cleanList(payload.cc);
      if (!to || !allEmails(to) || (cc && !allEmails(cc))) throw new HttpError(400, "Check the email addresses");
      if (!String(payload.body ?? "").trim()) throw new HttpError(400, "The email is empty");
      if (/\[[^\]]{2,}\]/.test(payload.body)) throw new HttpError(400, "Fill in the [bracketed] parts before sending");
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
    } else if (action.kind === "create_event") {
      const token = await accessToken(profile.id);
      if (!token) throw new HttpError(400, "Connect Google in Settings first");
      const ev = await calendarInsert(token, {
        summary: payload.summary, start: payload.start, end: payload.end, timezone: payload.timezone ?? profile.timezone,
        location: payload.location ?? undefined, description: payload.description ?? undefined, attendees: payload.attendees ?? [],
      });
      result = { event_id: ev.id, link: ev.htmlLink };
    } else if (action.kind === "concierge") {
      result = { marked_done: true };
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("actions").update({ status: "failed", decided_at: new Date().toISOString(), result: { error: msg }, payload }).eq("id", action.id);
    throw new HttpError(502, `Could not finish: ${msg}`);
  }

  await db.from("actions").update({ status: "done", decided_at: new Date().toISOString(), result, payload }).eq("id", action.id);
  return json({ ok: true, status: "done", result });
});
