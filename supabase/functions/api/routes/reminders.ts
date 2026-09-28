// Fires due reminders every 5 minutes: in app notification, plus an email to self when Google is connected.
import { admin, handle, HttpError, isCron, json } from "../shared/util.ts";
import { accessToken, gmailSend } from "../shared/google.ts";

export default handle(async (req) => {
  if (!(await isCron(req))) throw new HttpError(401, "Scheduled job only");
  const db = admin();
  const { data: due } = await db.from("tasks").select("id, user_id, title, notes, due_at")
    .eq("status", "open").eq("reminded", false).lte("remind_at", new Date().toISOString()).limit(200);
  let sent = 0;
  for (const t of due ?? []) {
    await db.from("tasks").update({ reminded: true }).eq("id", t.id);
    await db.from("notifications").insert({ user_id: t.user_id, title: `Reminder: ${t.title}`, body: t.notes ?? null, link: "#/tasks" });
    const { data: p } = await db.from("profiles").select("remind_by_email, timezone").eq("id", t.user_id).single();
    if (!p?.remind_by_email) continue;
    const { data: g } = await db.from("google_accounts").select("google_email").eq("user_id", t.user_id).maybeSingle();
    if (!g?.google_email) continue;
    try {
      const token = await accessToken(t.user_id);
      if (!token) continue;
      const when = t.due_at ? `\nDue: ${new Date(t.due_at).toLocaleString("en-US", { timeZone: p.timezone, dateStyle: "full", timeStyle: "short" })}` : "";
      await gmailSend(token, { to: g.google_email, subject: `Reminder: ${t.title}`, body: `${t.title}${when}${t.notes ? `\n\n${t.notes}` : ""}\n\nSent by your Twofold assistant.` });
      sent++;
    } catch (e) {
      console.error("reminder email", e);
    }
  }
  return json({ due: due?.length ?? 0, emailed: sent });
});
