// Every 5 minutes: run rule approved actions whose undo window passed, then fire due reminders.
import { admin, handle, HttpError, isCron, json } from "../shared/util.ts";
import { accessToken, gmailSend } from "../shared/google.ts";
import { logActivity, notify, runScheduled } from "../shared/trust.ts";

export default handle(async (req) => {
  if (!(await isCron(req))) throw new HttpError(401, "Scheduled job only");
  const db = admin();
  const ran = await runScheduled();
  const { data: due } = await db.from("tasks").select("id, user_id, title, notes, due_at, remind_at, source")
    .eq("status", "open").eq("reminded", false).lte("remind_at", new Date().toISOString()).limit(200);
  let sent = 0;
  for (const t of due ?? []) {
    await db.from("tasks").update({ reminded: true }).eq("id", t.id);
    const { data: p } = await db.from("profiles").select("remind_by_email, timezone").eq("id", t.user_id).single();
    const at = new Date(t.remind_at).toLocaleString("en-US", { timeZone: p?.timezone ?? "UTC", dateStyle: "medium", timeStyle: "short" });
    const why = t.source === "email" ? `An email mentioned this date, so I set a reminder for ${at}` : `You asked to be reminded at ${at}`;
    await notify({ user_id: t.user_id, title: `Reminder: ${t.title}`, body: t.notes ?? null, link: "#/tasks", why, importance: 2 });
    await logActivity({ user_id: t.user_id, kind: "reminder", title: `Reminded you: ${t.title}`, why, ref_type: "task", ref_id: t.id });
    if (!p?.remind_by_email) continue;
    const { data: g } = await db.from("google_accounts").select("google_email").eq("user_id", t.user_id).maybeSingle();
    if (!g?.google_email) continue;
    try {
      const token = await accessToken(t.user_id);
      if (!token) continue;
      const when = t.due_at ? `\nDue: ${new Date(t.due_at).toLocaleString("en-US", { timeZone: p.timezone, dateStyle: "full", timeStyle: "short" })}` : "";
      await gmailSend(token, { to: g.google_email, subject: `Reminder: ${t.title}`, body: `${t.title}${when}${t.notes ? `\n\n${t.notes}` : ""}\n\nWhy now: ${why}\n\nSent by your Twofold assistant.` });
      sent++;
    } catch (e) {
      console.error("reminder email", e);
    }
  }
  const family = await familyReminders();
  return json({ scheduled_ran: ran, due: due?.length ?? 0, emailed: sent, family });
});

/** Chores and family items with a due time ping whoever they are assigned to (or the adults, if nobody is). */
async function familyReminders() {
  const db = admin();
  const { data: items } = await db.from("list_items").select("id, text, due_at, assigned_to, repeat, list_id, lists(title, owner_id, household_id, shared)")
    .eq("done", false).eq("remind", true).is("reminded_at", null).lte("due_at", new Date().toISOString()).limit(300);
  let n = 0;
  for (const it of (items ?? []) as any[]) {
    await db.from("list_items").update({ reminded_at: new Date().toISOString() }).eq("id", it.id);
    const list = it.lists;
    let users: string[] = [];
    let who = "";
    let forSelf = false;
    if (it.assigned_to) {
      const { data: m } = await db.from("household_members").select("user_id, name, household_id").eq("id", it.assigned_to).maybeSingle();
      who = m?.name ?? "";
      if (m?.user_id) { users = [m.user_id]; forSelf = true; }
      else if (m) {
        // kids without a login: remind the adults
        const { data: adults } = await db.from("household_members").select("user_id").eq("household_id", m.household_id).in("role", ["owner", "adult"]);
        users = (adults ?? []).map((a) => a.user_id).filter(Boolean);
      }
    } else if (list?.shared && list.household_id) {
      const { data: adults } = await db.from("household_members").select("user_id").eq("household_id", list.household_id).in("role", ["owner", "adult"]);
      users = (adults ?? []).map((a) => a.user_id).filter(Boolean);
    } else if (list?.owner_id) users = [list.owner_id];
    for (const u of users) {
      await notify({
        user_id: u, title: `${who && !forSelf ? `${who}: ` : ""}${it.text}`,
        body: `${list?.title ?? "List"}${it.repeat ? ` · repeats ${it.repeat}` : ""}`, link: "#/home",
        why: it.assigned_to ? `It is due now and assigned to ${forSelf ? "you" : who}` : "It is due now and nobody has claimed it", importance: 2,
      });
      n++;
    }
  }
  return n;
}
