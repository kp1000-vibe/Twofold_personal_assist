// Hourly: scheduled automations, the daily "you didn't ask, but" scan, and the weekly friction radar.
// Code finds candidate signals, Jev decides which are worth interrupting for, every alert says why now.
import { admin, clip, handle, HttpError, isCron, json, localNow, Profile } from "../shared/util.ts";
import { claudeJson, jev, MODELS, score } from "../shared/ai.ts";
import { logActivity, notify } from "../shared/trust.ts";
import { runAutomation } from "../shared/automations.ts";
import { runPremortem } from "../shared/premortem.ts";
import { runDecisionReplay } from "../shared/replay.ts";

const SCAN_HOUR = 16;      // afternoon scan, local time
const RADAR_DAY = 0;       // Sunday
const RADAR_HOUR = 17;
const PREMORTEM_HOUR = 18; // Sunday evening, local time
const REPLAY_HOUR = 11;    // late morning, a calm moment to reflect

type Signal = { key: string; title: string; body: string; why: string; link: string };

export default handle(async (req) => {
  if (!(await isCron(req))) throw new HttpError(401, "Scheduled job only");
  const db = admin();
  const { data: users } = await db.from("profiles").select("*").eq("beta_access", true);
  let autos = 0, scans = 0, radars = 0, premortems = 0, replays = 0;
  for (const u of (users ?? []) as Profile[]) {
    const now = localNow(u.timezone);
    const weekday = new Date(`${now.date}T12:00:00Z`).getUTCDay();
    try {
      const { data: due } = await db.from("automations").select("*").eq("user_id", u.id).eq("enabled", true).in("trigger", ["daily", "weekly"]).eq("hour", now.hour);
      for (const a of due ?? []) {
        if (a.trigger === "weekly" && a.weekday !== weekday) continue;
        if (a.last_run_at && Date.now() - new Date(a.last_run_at).getTime() < 50 * 60_000) continue;
        await runAutomation(u, a, undefined, a.trigger === "daily" ? `your daily schedule (${now.hour}:00)` : "your weekly schedule");
        autos++;
      }
      if (now.hour === SCAN_HOUR) { await dailyScan(u, now.date); scans++; }
      if (now.hour === RADAR_HOUR && weekday === RADAR_DAY) { await frictionRadar(u); radars++; }
      if (now.hour === PREMORTEM_HOUR && weekday === RADAR_DAY && (u as any).premortem_enabled !== false) {
        const { data: done } = await db.from("premortems").select("id").eq("user_id", u.id).gt("created_at", new Date(Date.now() - 12 * 3600_000).toISOString()).limit(1);
        if (!done?.length) { await runPremortem(u); premortems++; }
      }
      if (now.hour === REPLAY_HOUR && (await runDecisionReplay(u))) replays++;
    } catch (e) {
      console.error("insights", u.id, e);
    }
  }
  return json({ users: users?.length ?? 0, autos, scans, radars, premortems, replays });
});

async function alreadySaid(uid: string, key: string) {
  const { data } = await admin().from("activity").select("id").eq("user_id", uid).eq("kind", "insight").eq("ref_id", key).maybeSingle();
  return !!data;
}

/** Collect candidate signals with plain code, let Jev score each for interrupt worthiness in one call. */
async function dailyScan(u: Profile, today: string) {
  const db = admin();
  const signals: Signal[] = [];
  const in7 = new Date(Date.now() + 7 * 864e5);
  const year = today.slice(0, 4);

  // birthdays in the next 7 days
  const { data: people } = await db.from("people").select("id, name, birthday, relation, last_contact_at").eq("user_id", u.id);
  for (const p of people ?? []) {
    if (!p.birthday) continue;
    const md = p.birthday.length >= 10 ? p.birthday.slice(5, 10) : p.birthday.slice(0, 5);
    let when = new Date(`${year}-${md}T12:00:00Z`);
    if (when.getTime() < Date.now() - 864e5) when = new Date(`${Number(year) + 1}-${md}T12:00:00Z`);
    if (isNaN(when.getTime()) || when > in7) continue;
    const days = Math.max(0, Math.round((when.getTime() - Date.now()) / 864e5));
    signals.push({
      key: `birthday:${p.id}:${when.getUTCFullYear()}`, title: `${p.name}'s birthday is ${days === 0 ? "today" : `in ${days} days`}`,
      body: "Want me to draft a message or find a gift?", link: `#/chat?q=${encodeURIComponent(`Help me plan something for ${p.name}'s birthday`)}`,
      why: `You saved ${p.name}'s birthday as ${p.birthday}, and it is ${days === 0 ? "today" : `${days} days away`}, enough time to act`,
    });
  }
  // close people not contacted in 45 days
  for (const p of people ?? []) {
    if (!p.relation || !/family|mom|dad|mother|father|sister|brother|partner|wife|husband|friend|parent/i.test(p.relation)) continue;
    if (!p.last_contact_at || Date.now() - new Date(p.last_contact_at).getTime() < 45 * 864e5) continue;
    const month = today.slice(0, 7);
    signals.push({
      key: `keepintouch:${p.id}:${month}`, title: `It has been a while since you wrote to ${p.name}`, body: "A quick note could be nice.",
      link: `#/chat?q=${encodeURIComponent(`Draft a short catch up note to ${p.name}`)}`,
      why: `Your last email with ${p.name} (${p.relation}) was ${Math.round((Date.now() - new Date(p.last_contact_at).getTime()) / 864e5)} days ago`,
    });
  }
  // promises past due
  const { data: overdue } = await db.from("tasks").select("id, title, due_at").eq("user_id", u.id).eq("status", "open").eq("kind", "commitment").lt("due_at", new Date().toISOString());
  for (const t of overdue ?? []) {
    signals.push({ key: `overdue:${t.id}`, title: `A promise is overdue: ${t.title}`, body: "Do it now, or let them know about a new date?", link: "#/tasks", why: `You committed to this for ${t.due_at?.slice(0, 10)}, which has passed` });
  }
  // renewals in the next 3 days
  const in3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
  const { data: subs } = await db.from("subscriptions").select("id, merchant, amount, currency, next_expected_at").eq("user_id", u.id).eq("status", "active").gte("next_expected_at", today).lte("next_expected_at", in3);
  for (const s of subs ?? []) {
    signals.push({ key: `renew:${s.id}:${s.next_expected_at}`, title: `${s.merchant} renews ${s.next_expected_at}${s.amount ? ` for ${s.amount} ${s.currency ?? ""}` : ""}`, body: "Still using it? I can help cancel.", link: "#/money", why: "Based on your last receipt, the next charge lands within 3 days" });
  }
  // stalled goals
  const { data: goals } = await db.from("goals").select("id, title, last_checkin_at, target_date").eq("user_id", u.id).eq("status", "active");
  for (const g of goals ?? []) {
    const { data: recent } = await db.from("tasks").select("id").eq("goal_id", g.id).eq("status", "done").gt("completed_at", new Date(Date.now() - 7 * 864e5).toISOString()).limit(1);
    if (recent?.length) continue;
    if (g.last_checkin_at && Date.now() - new Date(g.last_checkin_at).getTime() < 7 * 864e5) continue;
    const week = `${today.slice(0, 4)}w${Math.floor(new Date(today).getTime() / (7 * 864e5))}`;
    signals.push({ key: `goal:${g.id}:${week}`, title: `Check in on your goal: ${g.title}`, body: "No steps finished this week. Want to adjust the plan?", link: `#/chat?q=${encodeURIComponent(`Check in on my goal: ${g.title}`)}`, why: `No progress logged in 7 days${g.target_date ? `, and the target is ${g.target_date}` : ""}` });
  }

  const fresh: Signal[] = [];
  for (const s of signals) if (!(await alreadySaid(u.id, s.key))) fresh.push(s);
  if (!fresh.length) return;

  const qs: Record<string, any> = {};
  fresh.forEach((s, i) => {
    qs[`s${i}`] = { type: "score", instructions: { insight: `${s.title}. ${s.why}`, question: "How worthwhile is it to interrupt the user about `insight` today?" }, criteria: ["Not worth mentioning", "Mention quietly", "Worth a heads up", "Important, tell them now"] };
  });
  const { answers } = await jev(u.id, "insight_gate", { user_timezone: u.timezone, today }, qs);
  for (const [i, s] of fresh.entries()) {
    const imp = score(answers, `s${i}`)?.score ?? 1.5;
    if (imp < 0.8) continue;
    await notify({ user_id: u.id, title: s.title, body: s.body, link: s.link, why: s.why, importance: imp });
    await logActivity({ user_id: u.id, kind: "insight", title: s.title, why: s.why, ref_type: "insight", ref_id: s.key });
  }
}

/** Weekly: spot repeated manual work and patterns, suggest automations. Jev gates what gets shown. */
async function frictionRadar(u: Profile) {
  const db = admin();
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const [{ data: msgs }, { data: tasks }, { data: autos }] = await Promise.all([
    db.from("messages").select("content, created_at").eq("user_id", u.id).eq("role", "user").gt("created_at", since).order("created_at").limit(150),
    db.from("tasks").select("title, kind, status, created_at").eq("user_id", u.id).gt("created_at", since).limit(150),
    db.from("automations").select("title, instruction").eq("user_id", u.id),
  ]);
  if ((msgs?.length ?? 0) + (tasks?.length ?? 0) < 8) return;
  const found = await claudeJson<{ suggestions: { title: string; evidence: string; automation: string }[] }>({
    userId: u.id, purpose: "friction_radar", model: MODELS.haiku, max_tokens: 700,
    system: "You look for repeated manual work and recurring worries in a user's last 30 days. Suggest at most 3 automations the assistant could run for them. Only suggest things clearly supported by repetition (3 or more times). Skip anything already automated. Reply with JSON only: {\"suggestions\": [{\"title\": short, \"evidence\": what repeated and how often, \"automation\": the instruction the assistant would follow}]}",
    messages: [{ role: "user", content: JSON.stringify({ requests: (msgs ?? []).map((m) => clip(m.content, 160)), tasks: (tasks ?? []).map((t) => `${t.kind}: ${t.title} (${t.status})`), already_automated: autos ?? [] }) }],
  });
  const list = found?.suggestions?.slice(0, 3) ?? [];
  if (!list.length) return;
  const qs: Record<string, any> = {};
  list.forEach((s, i) => { qs[`a${i}`] = { type: "noul", instructions: { suggestion: `${s.title}: ${s.evidence}`, question: "Would a busy person likely welcome `suggestion` as an automation?" } }; });
  const { answers } = await jev(u.id, "radar_gate", {}, qs);
  for (const [i, s] of list.entries()) {
    const p = (answers[`a${i}`] as any)?.noul ?? 0;
    if (p < 0.7) continue;
    const key = `radar:${s.title.toLowerCase().slice(0, 60)}`;
    if (await alreadySaid(u.id, key)) continue;
    await notify({
      user_id: u.id, title: `You didn't ask, but I can automate this: ${s.title}`, body: s.automation,
      link: `#/chat?q=${encodeURIComponent(`Set up an automation: ${s.automation}`)}`, why: s.evidence, importance: 1.8,
    });
    await logActivity({ user_id: u.id, kind: "insight", title: `Suggested automation: ${s.title}`, why: s.evidence, ref_type: "insight", ref_id: key });
  }
}
