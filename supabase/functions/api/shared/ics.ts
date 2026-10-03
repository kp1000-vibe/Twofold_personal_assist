// A small, dependency free iCalendar reader: events, time zones, all day events, repeats (RRULE),
// skipped dates (EXDATE), moved occurrences (RECURRENCE-ID) and cancellations.
// School districts, daycares and sports apps (TeamSnap, GameChanger, SportsEngine) publish feeds like this.

export type Occurrence = { uid: string; title: string; location: string | null; start: number; end: number; allDay: boolean };
type DT = { y: number; mo: number; d: number; h: number; mi: number; s: number; tz: string | null; utc: boolean; dateOnly: boolean };
type VEvent = {
  uid: string; summary: string; location: string | null; status: string; start: DT; end: DT | null; duration: number | null;
  rrule: Record<string, string> | null; exdates: Set<string>; recurrenceId: DT | null;
};

const WINDOWS_TZ: Record<string, string> = {
  "Pacific Standard Time": "America/Los_Angeles", "Mountain Standard Time": "America/Denver", "US Mountain Standard Time": "America/Phoenix",
  "Central Standard Time": "America/Chicago", "Eastern Standard Time": "America/New_York", "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu", "GMT Standard Time": "Europe/London", "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris", "India Standard Time": "Asia/Kolkata", "AUS Eastern Standard Time": "Australia/Sydney",
};
function validTz(tz: string | null, fallback: string) {
  if (!tz) return fallback;
  const t = WINDOWS_TZ[tz] ?? tz.replace(/^\/[^/]+\//, "");
  try { new Intl.DateTimeFormat("en-US", { timeZone: t }); return t; } catch { return fallback; }
}

function tzOffset(utcMs: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second")) - utcMs;
}
/** Wall clock time in a time zone to epoch ms (DST safe). */
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

function parseDT(value: string, params: Record<string, string>): DT {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) throw new Error(`bad date ${value}`);
  const dateOnly = params.VALUE === "DATE" || !m[4];
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), tz: params.TZID ?? null, utc: !!m[7], dateOnly };
}
const dtKey = (t: DT) => `${t.y}${String(t.mo).padStart(2, "0")}${String(t.d).padStart(2, "0")}${t.dateOnly ? "" : `T${String(t.h).padStart(2, "0")}${String(t.mi).padStart(2, "0")}`}`;

function toMs(t: DT, fallbackTz: string) {
  if (t.utc) return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
  return localToUtc(t.y, t.mo, t.d, t.h, t.mi, t.s, validTz(t.tz, fallbackTz));
}
function parseDuration(v: string) {
  const m = v.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}
const unescape = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

export function parseIcs(text: string): VEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: VEvent[] = [];
  let cur: Partial<VEvent> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { exdates: new Set(), status: "CONFIRMED", location: null, rrule: null, end: null, duration: null, recurrenceId: null, summary: "" }; continue; }
    if (line === "END:VEVENT") { if (cur?.uid && cur.start) out.push(cur as VEvent); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const [name, ...paramParts] = line.slice(0, i).split(";");
    const params: Record<string, string> = {};
    for (const p of paramParts) { const [k, v] = p.split("="); if (k && v) params[k.toUpperCase()] = v.replace(/^"|"$/g, ""); }
    const value = line.slice(i + 1);
    try {
      switch (name.toUpperCase()) {
        case "UID": cur.uid = value.trim(); break;
        case "SUMMARY": cur.summary = unescape(value); break;
        case "LOCATION": cur.location = unescape(value) || null; break;
        case "STATUS": cur.status = value.trim().toUpperCase(); break;
        case "DTSTART": cur.start = parseDT(value.trim(), params); break;
        case "DTEND": cur.end = parseDT(value.trim(), params); break;
        case "DURATION": cur.duration = parseDuration(value.trim()); break;
        case "RECURRENCE-ID": cur.recurrenceId = parseDT(value.trim(), params); break;
        case "RRULE": cur.rrule = Object.fromEntries(value.split(";").map((kv) => kv.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.toUpperCase(), v])); break;
        case "EXDATE": for (const v of value.split(",")) cur.exdates!.add(dtKey(parseDT(v.trim(), params))); break;
      }
    } catch { /* skip a malformed line, keep the rest of the event */ }
  }
  return out;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Pure date math on calendar days, independent of time zones. */
function addDays(y: number, mo: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() };
}

/** All occurrences that overlap [from, to], in epoch ms. Repeats are expanded in local wall clock time so 4 pm stays 4 pm across DST. */
export function expand(events: VEvent[], from: number, to: number, fallbackTz: string, cap = 600): Occurrence[] {
  const overrides = new Map<string, VEvent>();
  for (const e of events) if (e.recurrenceId) overrides.set(`${e.uid}|${dtKey(e.recurrenceId)}`, e);
  const out: Occurrence[] = [];
  const push = (e: VEvent, start: number, len: number, key: string) => {
    if (e.status === "CANCELLED") return;
    const end = start + Math.max(len, 0);
    if (end < from || start > to) return;
    out.push({ uid: `${e.uid}|${key}`, title: e.summary || "Event", location: e.location, start, end, allDay: e.start.dateOnly });
  };
  for (const e of events) {
    if (out.length >= cap) break;
    const tz = e.start.dateOnly ? fallbackTz : e.start.utc ? "UTC" : validTz(e.start.tz, fallbackTz);
    const startMs = e.start.dateOnly ? localToUtc(e.start.y, e.start.mo, e.start.d, 0, 0, 0, fallbackTz) : toMs(e.start, fallbackTz);
    const len = e.duration ?? (e.end ? (e.end.dateOnly ? localToUtc(e.end.y, e.end.mo, e.end.d, 0, 0, 0, fallbackTz) : toMs(e.end, fallbackTz)) - startMs : e.start.dateOnly ? 86400000 : 3600000);
    if (e.recurrenceId) { push(e, startMs, len, dtKey(e.recurrenceId)); continue; }
    if (!e.rrule) { push(e, startMs, len, dtKey(e.start)); continue; }

    const r = e.rrule;
    const freq = r.FREQ ?? "WEEKLY";
    const interval = Math.max(1, +(r.INTERVAL ?? 1));
    const count = r.COUNT ? +r.COUNT : Infinity;
    const until = r.UNTIL ? (() => { const u = parseDT(r.UNTIL, {}); return u.utc || u.dateOnly ? (u.dateOnly ? localToUtc(u.y, u.mo, u.d, 23, 59, 59, tz === "UTC" ? fallbackTz : tz) : toMs(u, fallbackTz)) : toMs({ ...u, tz }, fallbackTz); })() : Infinity;
    const byday = (r.BYDAY ?? "").split(",").filter(Boolean);
    const bymonthday = (r.BYMONTHDAY ?? "").split(",").filter(Boolean).map(Number);
    const at = (y: number, mo: number, d: number) => e.start.dateOnly ? localToUtc(y, mo, d, 0, 0, 0, fallbackTz)
      : tz === "UTC" ? Date.UTC(y, mo - 1, d, e.start.h, e.start.mi, e.start.s) : localToUtc(y, mo, d, e.start.h, e.start.mi, e.start.s, tz);
    let made = 0;
    const emit = (y: number, mo: number, d: number) => {
      const s = at(y, mo, d);
      if (s < startMs) return true;
      if (s > until || made >= count || s > to) return false;
      made++;
      const key = dtKey({ ...e.start, y, mo, d });
      if (e.exdates.has(key) || e.exdates.has(key.slice(0, 8))) return true;
      if (overrides.has(`${e.uid}|${key}`)) return true; // the moved copy is its own event
      push(e, s, len, key);
      return out.length < cap;
    };

    const s0 = { y: e.start.y, mo: e.start.mo, d: e.start.d };
    let guard = 0;
    if (freq === "DAILY") {
      for (let i = 0; guard++ < 5000; i += interval) { const t = addDays(s0.y, s0.mo, s0.d, i); if (!emit(t.y, t.mo, t.d)) break; }
    } else if (freq === "WEEKLY") {
      const days = byday.length ? byday.map((x) => DAYS.indexOf(x.slice(-2))).filter((x) => x >= 0).sort() : [addDays(s0.y, s0.mo, s0.d, 0).wd];
      const weekStart = addDays(s0.y, s0.mo, s0.d, -addDays(s0.y, s0.mo, s0.d, 0).wd); // the Sunday of the first week
      let stop = false;
      for (let w = 0; !stop && guard++ < 2000; w += interval) {
        for (const wd of days) { const t = addDays(weekStart.y, weekStart.mo, weekStart.d, w * 7 + wd); if (!emit(t.y, t.mo, t.d)) { stop = true; break; } }
      }
    } else if (freq === "MONTHLY" || freq === "YEARLY") {
      let stop = false;
      for (let k = 0; !stop && guard++ < 600; k += interval) {
        const base = new Date(Date.UTC(s0.y, s0.mo - 1 + (freq === "MONTHLY" ? k : k * 12), 1));
        const y = base.getUTCFullYear(), mo = base.getUTCMonth() + 1;
        const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
        let dates: number[] = [];
        if (bymonthday.length) dates = bymonthday.map((n) => (n < 0 ? dim + n + 1 : n)).filter((n) => n >= 1 && n <= dim);
        else if (byday.length) {
          for (const b of byday) {
            const m = b.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
            if (!m) continue;
            const wd = DAYS.indexOf(m[2]);
            const all = Array.from({ length: dim }, (_, i) => i + 1).filter((d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd);
            if (!m[1]) dates.push(...all);
            else { const n = +m[1]; const pick = n > 0 ? all[n - 1] : all[all.length + n]; if (pick) dates.push(pick); }
          }
        } else if (s0.d <= dim) dates = [s0.d];
        for (const d of [...new Set(dates)].sort((a, b) => a - b)) if (!emit(y, mo, d)) { stop = true; break; }
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
