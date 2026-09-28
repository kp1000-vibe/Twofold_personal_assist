// Sunday pre mortem: walk through next week before it happens and find where it will break.
// Code measures the week (meeting load, conflicts, free time, deadlines). Jev scores every candidate risk
// for a fraction of a cent. Claude only writes the top few, with fixes that fit into real free time.
import { admin, clip, localNow, Profile } from "./util.ts";
import { claudeJson, jev, MODELS, score } from "./ai.ts";
import { accessToken, calendarList, CalEvent } from "./google.ts";
import { logActivity, notify, queueAction } from "./trust.ts";

const DAY_START = 8 * 60;   // working window for free time, local minutes
const DAY_END = 19 * 60;
const MIN_FREE = 60;

type Risk = { key: string; day: string | null; text: string; evidence: string };
type Win = { day: string; start: string; end: string; minutes: number };

function localParts(iso: string, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, min: (Number(g("hour")) % 24) * 60 + Number(g("minute")) };
}
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekdayName = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const offsetOn = (date: string, tz: string) => localNow(tz, new Date(`${date}T12:00:00Z`)).offset;
const hours = (m: number) => Math.round(m / 6) / 10;

/** Which days to check: on Sunday (or Saturday) the coming Monday to Sunday, otherwise the rest of this week. */
export function targetWeek(tz: string) {
  const now = localNow(tz);
  const wd = new Date(`${now.date}T12:00:00Z`).getUTCDay();
  const start = wd === 0 ? addDays(now.date, 1) : wd === 6 ? addDays(now.date, 2) : now.date;
  const monday = wd === 0 ? start : wd === 6 ? start : addDays(now.date, 1 - wd);
  const days: string[] = [];
  for (let d = start; d <= addDays(monday, 6); d = addDays(d, 1)) days.push(d);
  return { monday, days };
}

/** Pure measurement of the week: busy blocks, conflicts, chains, free windows and deadline crunches. */
export function measureDays(days: string[], events: CalEvent[], tasks: { id: string; title: string; kind: string; due_at: string; goal_id: string | null }[], tz: string) {
  // ------------------------------------------------------------ measure each day in code
  const byDay = new Map<string, { s: number; e: number; title: string }[]>();
  const allDay = new Map<string, string[]>();
  for (const d of days) { byDay.set(d, []); allDay.set(d, []); }
  for (const ev of events) {
    if (ev.allDay) {
      const d = String(ev.start).slice(0, 10);
      allDay.get(d)?.push(ev.summary);
      continue;
    }
    const s = localParts(ev.start, tz), e = localParts(ev.end, tz);
    if (!byDay.has(s.date)) continue;
    byDay.get(s.date)!.push({ s: s.min, e: e.date === s.date ? e.min : 24 * 60, title: ev.summary });
  }
  const dueBy = new Map<string, { title: string; kind: string; goal: boolean }[]>();
  for (const t of tasks) {
    const d = localParts(t.due_at, tz).date;
    if (!dueBy.has(d)) dueBy.set(d, []);
    dueBy.get(d)!.push({ title: t.title, kind: t.kind, goal: !!t.goal_id });
  }

  const risks: Risk[] = [];
  const free: Win[] = [];
  const stats: Record<string, unknown> = { days: days.length, events: events.length, meeting_hours: 0 };
  let totalMeet = 0;
  for (const d of days) {
    const evs = byDay.get(d)!.sort((a, b) => a.s - b.s);
    const name = weekdayName(d);
    // merged busy blocks
    const merged: { s: number; e: number }[] = [];
    for (const ev of evs) {
      const last = merged[merged.length - 1];
      if (last && ev.s <= last.e) last.e = Math.max(last.e, ev.e);
      else merged.push({ s: ev.s, e: ev.e });
    }
    const meetMin = merged.reduce((n, b) => n + (b.e - b.s), 0);
    totalMeet += meetMin;
    // conflicts
    for (let i = 1; i < evs.length; i++) {
      for (let j = 0; j < i; j++) {
        if (evs[i].s < evs[j].e && evs[j].s < evs[i].e) {
          risks.push({ key: `conflict:${d}:${i}:${j}`, day: d, text: `${name}: "${evs[j].title}" and "${evs[i].title}" overlap`, evidence: `Both at ${hhmm(Math.max(evs[i].s, evs[j].s))}` });
        }
      }
    }
    // back to back chains (gaps under 10 minutes)
    let chainStart = -1, chainEnd = -1, longest = 0;
    for (const ev of evs) {
      if (chainStart < 0 || ev.s - chainEnd >= 10) { chainStart = ev.s; chainEnd = ev.e; }
      else chainEnd = Math.max(chainEnd, ev.e);
      longest = Math.max(longest, chainEnd - chainStart);
    }
    // free windows inside the working day
    let cursor = DAY_START, longestFree = 0;
    for (const b of [...merged, { s: DAY_END, e: DAY_END }]) {
      const s = Math.max(cursor, DAY_START), e = Math.min(b.s, DAY_END);
      if (e - s >= MIN_FREE) { free.push({ day: d, start: hhmm(s), end: hhmm(e), minutes: e - s }); }
      if (e > s) longestFree = Math.max(longestFree, e - s);
      cursor = Math.max(cursor, b.e);
    }
    const due = dueBy.get(d) ?? [];
    if (meetMin >= 5 * 60) risks.push({ key: `heavy:${d}`, day: d, text: `${name} has ${hours(meetMin)} hours of meetings`, evidence: `${evs.length} events, longest free stretch ${hours(longestFree)} hours` });
    if (longest >= 3 * 60) risks.push({ key: `chain:${d}`, day: d, text: `${name} runs ${hours(longest)} hours back to back with no break`, evidence: "Gaps under 10 minutes between meetings" });
    if (due.length && longestFree < 90) risks.push({ key: `crunch:${d}`, day: d, text: `${name}: ${due.length} thing${due.length > 1 ? "s" : ""} due (${due.map((x) => x.title).slice(0, 3).join(", ")}) but no 90 minute block to do ${due.length > 1 ? "them" : "it"}`, evidence: `Longest free stretch ${hours(longestFree)} hours` });
    const early = evs.find((x) => x.s < 7 * 60 + 30), late = evs.find((x) => x.e > 19 * 60 + 30);
    if (early) risks.push({ key: `early:${d}`, day: d, text: `${name} starts early: "${early.title}" at ${hhmm(early.s)}`, evidence: "Before 7:30" });
    if (late) risks.push({ key: `late:${d}`, day: d, text: `${name} runs late: "${late.title}" until ${hhmm(late.e)}`, evidence: "After 7:30 pm" });
    const promises = due.filter((x) => x.kind === "commitment");
    if (promises.length) risks.push({ key: `promise:${d}`, day: d, text: `${name}: you promised ${promises.map((x) => x.title).join(", ")}`, evidence: "Commitment due that day" });
    if (allDay.get(d)!.length && meetMin >= 3 * 60) risks.push({ key: `allday:${d}`, day: d, text: `${name}: ${allDay.get(d)!.join(", ")} plus ${hours(meetMin)} hours of meetings`, evidence: "All day item on a busy day" });
  }
  stats.meeting_hours = hours(totalMeet);
  return { risks, free, stats };
}

export async function runPremortem(u: Profile, opts: { manual?: boolean } = {}) {
  const db = admin();
  const tz = u.timezone;
  const { monday, days } = targetWeek(tz);
  const first = days[0], last = days[days.length - 1];
  const rangeStart = new Date(`${first}T00:00:00${offsetOn(first, tz)}`).toISOString();
  const rangeEnd = new Date(`${addDays(last, 1)}T00:00:00${offsetOn(last, tz)}`).toISOString();

  // ------------------------------------------------------------ gather
  const token = await accessToken(u.id);
  const events: CalEvent[] = token ? await calendarList(token, rangeStart, rangeEnd, 150).catch(() => []) : [];
  const [{ data: tasks }, { data: overdue }, { data: subs }, { data: people }, { data: goals }] = await Promise.all([
    db.from("tasks").select("id, title, kind, due_at, goal_id").eq("user_id", u.id).eq("status", "open").gte("due_at", rangeStart).lt("due_at", rangeEnd),
    db.from("tasks").select("id, title, due_at").eq("user_id", u.id).eq("status", "open").eq("kind", "commitment").lt("due_at", rangeStart),
    db.from("subscriptions").select("merchant, amount, currency, next_expected_at").eq("user_id", u.id).eq("status", "active").gte("next_expected_at", first).lte("next_expected_at", last),
    db.from("people").select("name, birthday, relation").eq("user_id", u.id).not("birthday", "is", null),
    db.from("goals").select("id, title, target_date").eq("user_id", u.id).eq("status", "active"),
  ]);

  const { risks, free, stats } = measureDays(days, events, tasks ?? [], tz);

  for (const t of overdue ?? []) risks.push({ key: `overdue:${t.id}`, day: null, text: `Still open from before: you promised "${t.title}"`, evidence: `Was due ${String(t.due_at).slice(0, 10)}` });
  for (const s of subs ?? []) risks.push({ key: `renew:${s.merchant}`, day: s.next_expected_at, text: `${s.merchant} renews ${weekdayName(s.next_expected_at)}${s.amount ? ` for ${s.amount} ${s.currency ?? ""}` : ""}`, evidence: "From past receipts" });
  for (const p of people ?? []) {
    const md = p.birthday.length >= 10 ? p.birthday.slice(5, 10) : p.birthday.slice(0, 5);
    const hit = days.find((d) => d.slice(5) === md);
    if (hit) risks.push({ key: `bday:${p.name}`, day: hit, text: `${p.name}${p.relation ? ` (${p.relation})` : ""} has a birthday on ${weekdayName(hit)}`, evidence: "Saved birthday" });
  }
  for (const g of goals ?? []) {
    const steps = (tasks ?? []).filter((t) => t.goal_id === g.id);
    if (steps.length) risks.push({ key: `goal:${g.id}`, day: null, text: `${steps.length} step${steps.length > 1 ? "s" : ""} for your goal "${g.title}" are due this week`, evidence: steps.map((x) => x.title).join(", ") });
  }
  const totalFree = free.reduce((n, w) => n + w.minutes, 0);
  if (days.length >= 4 && totalFree < 6 * 60 && events.length) risks.push({ key: "nofocus", day: null, text: `Only ${hours(totalFree)} hours of open time all week`, evidence: "Free blocks of an hour or more between 8 and 7" });
  stats.free_hours = hours(totalFree);
  stats.checks = risks.length;

  // ------------------------------------------------------------ Jev scores every candidate
  let top: (Risk & { score: number })[] = [];
  if (risks.length) {
    const qs: Record<string, any> = {};
    risks.slice(0, 60).forEach((r, i) => {
      qs[`r${i}`] = { type: "score", instructions: { risk: `${r.text}. ${r.evidence}`, question: "How likely is `risk` to actually cause stress, a missed promise, or a dropped ball this week?" }, criteria: ["Harmless", "Minor annoyance", "Likely to cause a problem", "Will almost certainly break something"] };
    });
    const { answers } = await jev(u.id, "premortem_gate", { week_of: monday, meeting_hours: stats.meeting_hours, free_hours: stats.free_hours }, qs);
    top = risks.slice(0, 60).map((r, i) => ({ ...r, score: score(answers, `r${i}`)?.score ?? 0 }))
      .filter((r) => r.score >= 1.2).sort((a, b) => b.score - a.score).slice(0, 3);
  }

  // ------------------------------------------------------------ Claude writes only the few that matter
  type Fix = { title: string; why: string; fix: string; block?: { day: string; start: string; end: string; summary: string } };
  let headline = "Your week looks calm. Nothing is likely to break.";
  let fixes: Fix[] = [];
  if (top.length) {
    const out = await claudeJson<{ headline: string; risks: Fix[] }>({
      userId: u.id, purpose: "premortem", model: MODELS.sonnet, max_tokens: 900,
      system: [
        "You run a pre mortem on someone's coming week: imagine it went badly and say where it broke, then a concrete fix for each.",
        "Use only the facts given. Be warm and specific, like a sharp chief of staff. No filler.",
        "When protected time would help, you may propose a block inside one of free_windows exactly (same day, start and end within the window, 30 to 120 minutes).",
        "Reply with JSON only: {\"headline\": one sentence summary of the week, \"risks\": [{\"title\": short, \"why\": one sentence, \"fix\": one sentence, \"block\": optional {\"day\": YYYY-MM-DD, \"start\": HH:MM, \"end\": HH:MM, \"summary\": short calendar title}}]}",
      ].join("\n"),
      messages: [{ role: "user", content: JSON.stringify({ week_of: monday, stats, top_risks: top.map((r) => ({ what: r.text, evidence: r.evidence, day: r.day })), free_windows: free.slice(0, 30) }) }],
    });
    headline = out?.headline || `${top.length} spot${top.length > 1 ? "s" : ""} in your week could break.`;
    fixes = (out?.risks ?? []).slice(0, 3);
  }

  // ------------------------------------------------------------ turn safe fixes into proposals
  const actionIds: string[] = [];
  for (const f of fixes) {
    const b = f.block;
    if (!b || !token) { delete f.block; continue; }
    const toMin = (x: string) => { const [h, m] = x.split(":").map(Number); return h * 60 + m; };
    const fits = free.some((w) => w.day === b.day && toMin(b.start) >= toMin(w.start) && toMin(b.end) <= toMin(w.end) && toMin(b.end) - toMin(b.start) >= 30);
    if (!fits || !/^\d{2}:\d{2}$/.test(b.start) || !/^\d{2}:\d{2}$/.test(b.end)) { delete f.block; continue; }
    const off = offsetOn(b.day, tz);
    const r = await queueAction({
      user_id: u.id, kind: "create_event", title: `Protect time: ${clip(b.summary, 60)}`, source: "premortem",
      summary: `${weekdayName(b.day)} ${b.start} to ${b.end}`,
      payload: { summary: clip(b.summary, 80), start: `${b.day}T${b.start}:00${off}`, end: `${b.day}T${b.end}:00${off}`, timezone: tz, description: `Suggested by your Sunday week check: ${f.why}` },
      source_ref: `premortem:${monday}:${b.day}:${b.start}`,
    }, { upsert: true });
    if (r.id && (r.status === "pending" || r.status === "scheduled")) actionIds.push(r.id);
  }

  // ------------------------------------------------------------ save and tell them
  const lines = fixes.map((f, i) => `**${i + 1}. ${f.title}**\n${f.why}\nFix: ${f.fix}${f.block ? ` I drafted a focus block for ${weekdayName(f.block.day)} ${f.block.start} to ${f.block.end}, waiting in Approvals.` : ""}`);
  const content = [headline, ...lines].join("\n\n");
  stats.checked_by_jev = Math.min(risks.length, 60);
  await db.from("premortems").upsert({ user_id: u.id, week_start: monday, headline, content, risks: fixes, stats, created_at: new Date().toISOString() }, { onConflict: "user_id,week_start" });
  if (actionIds.length) await db.from("channels").update({ pending_actions: actionIds }).eq("user_id", u.id);

  const plainLines = fixes.map((f, i) => `${i + 1}. ${f.title}: ${f.why}\n   Fix: ${f.fix}`).join("\n\n");
  if (!opts.manual) {
    await notify({
      user_id: u.id, title: fixes.length ? `Your week check: ${fixes.length} spot${fixes.length > 1 ? "s" : ""} could break` : "Your week check: all clear",
      body: headline, link: "#/today", why: "Every Sunday evening Twofold walks through your coming week before it happens",
      importance: fixes.length ? 2.2 : 1,
      text: `🔮 Your week check\n\n${headline}${plainLines ? `\n\n${plainLines}` : ""}${actionIds.length ? `\n\nI drafted ${actionIds.length} focus block${actionIds.length > 1 ? "s" : ""}. Reply YES to add the first one, NO to skip.` : ""}`,
    });
  }
  await logActivity({ user_id: u.id, kind: "premortem", title: `Checked your week of ${monday}`, why: `${risks.length} things measured, Jev flagged ${top.length}`, ref_type: "premortem" });
  return { week_start: monday, headline, content, risks: fixes, stats };
}
