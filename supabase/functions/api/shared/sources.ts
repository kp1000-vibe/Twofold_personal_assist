// School and daycare plugins.
//   Calendar feeds: school district, class, daycare and team calendars (ICS links). Synced every 3 hours onto the family calendar.
//   Family inbox: a private forwarding address. Daycare and school apps (Brightwheel, ParentSquare, ClassDojo, Procare, Seesaw)
//   all email their updates, so forwarding those emails here turns them into family calendar events and tasks.
import { admin, clip } from "./util.ts";
import { expand, parseIcs } from "./ics.ts";
import { getFamily, postToThread } from "./family.ts";
import { schoolEmail } from "./familyAgent.ts";
import { notify } from "./trust.ts";

export const PROVIDERS: Record<string, { label: string; kind: "ics" | "email"; how: string }> = {
  school: { label: "School or district calendar", kind: "ics", how: "On the school website, find Calendar, then Subscribe, iCal or Add to Google Calendar, and copy that link." },
  teamsnap: { label: "TeamSnap", kind: "ics", how: "Schedule, then Export or Sync Calendar, copy the calendar link." },
  gamechanger: { label: "GameChanger", kind: "ics", how: "Team schedule, then Sync to Calendar, copy the link." },
  sportsengine: { label: "SportsEngine", kind: "ics", how: "Team calendar, then Subscribe, copy the iCal link." },
  google: { label: "A shared Google Calendar", kind: "ics", how: "Google Calendar settings for that calendar, then Secret address in iCal format." },
  other_feed: { label: "Any other calendar link", kind: "ics", how: "Any link ending in .ics or starting with webcal works." },
  brightwheel: { label: "Brightwheel", kind: "email", how: "Turn on email notifications in Brightwheel, then forward them to your family inbox." },
  parentsquare: { label: "ParentSquare", kind: "email", how: "Set notifications to email, then forward them to your family inbox." },
  classdojo: { label: "ClassDojo", kind: "email", how: "Turn on email notifications, then forward them to your family inbox." },
  procare: { label: "Procare", kind: "email", how: "Turn on email notifications, then forward them to your family inbox." },
  seesaw: { label: "Seesaw", kind: "email", how: "Turn on email notifications, then forward them to your family inbox." },
  school_email: { label: "School and teacher emails", kind: "email", how: "In Gmail, make a filter for the school's address and forward to your family inbox." },
};

const WINDOW_BACK = 864e5, WINDOW_AHEAD = 45 * 864e5;

export function normalizeFeedUrl(raw: string) {
  const u = String(raw ?? "").trim().replace(/^webcals?:\/\//i, "https://");
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}

async function fetchFeed(url: string) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Twofold family calendar" } });
    if (!res.ok) throw new Error(`The calendar link answered ${res.status}`);
    const text = await res.text();
    if (text.length > 4_000_000) throw new Error("That calendar is too large");
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("That link is not a calendar feed (no iCal data)");
    return text;
  } finally { clearTimeout(t); }
}

/** Pull one feed onto the family calendar and tell the family what changed. */
export async function syncSource(sourceId: string) {
  const db = admin();
  const { data: src } = await db.from("family_sources").select("*").eq("id", sourceId).single();
  if (!src || src.kind !== "ics") return { skipped: true };
  const { data: owner } = await db.from("profiles").select("timezone").eq("id", src.created_by).maybeSingle();
  const tz = owner?.timezone ?? "America/Los_Angeles";
  try {
    const occ = expand(parseIcs(await fetchFeed(src.url)), Date.now() - WINDOW_BACK, Date.now() + WINDOW_AHEAD, tz);
    const { data: existing } = await db.from("family_events").select("id, source_uid, title, start_at, location").eq("source_id", src.id);
    const have = new Map((existing ?? []).map((e) => [e.source_uid, e]));
    const seen = new Set<string>();
    const added: string[] = [], changed: string[] = [];
    const when = (ms: number, allDay: boolean) => new Date(ms).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", ...(allDay ? {} : { hour: "numeric", minute: "2-digit" }) });
    const soon = Date.now() + 14 * 864e5;
    for (const o of occ) {
      seen.add(o.uid);
      const row = {
        household_id: src.household_id, created_by: src.created_by, title: clip(o.title, 120), start_at: new Date(o.start).toISOString(),
        end_at: new Date(Math.max(o.end, o.start)).toISOString(), all_day: o.allDay, location: o.location, member_ids: src.member_ids,
        notes: `From ${src.name}`, source_id: src.id, source_uid: o.uid,
      };
      const prev = have.get(o.uid);
      if (!prev) {
        await db.from("family_events").insert(row);
        if (o.start < soon) added.push(`${o.title}, ${when(o.start, o.allDay)}`);
      } else if (new Date(prev.start_at).getTime() !== o.start || prev.title !== row.title || (prev.location ?? null) !== (o.location ?? null)) {
        await db.from("family_events").update({ title: row.title, start_at: row.start_at, end_at: row.end_at, all_day: row.all_day, location: row.location }).eq("id", prev.id);
        if (o.start < soon) changed.push(`${o.title} now ${when(o.start, o.allDay)}${o.location ? ` at ${o.location}` : ""}`);
      }
    }
    // gone from the feed: cancelled. Only future ones inside the window are removed.
    const removed: string[] = [];
    for (const [uid, e] of have) {
      const t = new Date(e.start_at).getTime();
      if (!seen.has(uid!) && t > Date.now() && t < Date.now() + WINDOW_AHEAD) {
        await db.from("family_events").delete().eq("id", e.id);
        if (t < soon) removed.push(`${e.title}, ${when(t, false)}`);
      }
    }
    const first = !src.last_synced_at;
    await db.from("family_sources").update({ last_synced_at: new Date().toISOString(), last_error: null, events_count: occ.length }).eq("id", src.id);
    if (first) {
      await postToThread(src.household_id, `📅 Connected **${src.name}**. ${occ.length} event${occ.length === 1 ? "" : "s"} in the next 6 weeks are now on the family calendar.${added.length ? `\nNext up: ${added.slice(0, 3).join("; ")}` : ""}`, { source_id: src.id });
    } else if (added.length || changed.length || removed.length) {
      const lines = [...changed.map((x) => `🔁 Changed: ${x}`), ...added.map((x) => `➕ New: ${x}`), ...removed.map((x) => `❌ Cancelled: ${x}`)].slice(0, 8);
      await postToThread(src.household_id, `📅 Update from **${src.name}**\n${lines.join("\n")}`, { source_id: src.id });
      if (changed.length || removed.length) {
        const { data: members } = await db.from("household_members").select("user_id").eq("household_id", src.household_id).not("user_id", "is", null);
        for (const m of members ?? []) await notify({ user_id: m.user_id!, title: `${src.name}: schedule changed`, body: clip(lines[0], 140), link: "#/family?tab=calendar", why: "A calendar your family follows changed in the next 2 weeks", importance: 2 });
      }
    }
    return { events: occ.length, added: added.length, changed: changed.length, removed: removed.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("family_sources").update({ last_synced_at: new Date().toISOString(), last_error: clip(msg, 300) }).eq("id", src.id);
    return { error: msg };
  }
}

export async function syncDueSources() {
  const { data } = await admin().from("family_sources").select("id, last_synced_at").eq("kind", "ics")
    .or(`last_synced_at.is.null,last_synced_at.lt.${new Date(Date.now() - 3 * 3600_000).toISOString()}`).limit(40);
  let n = 0;
  for (const s of data ?? []) { await syncSource(s.id); n++; }
  return n;
}

// ------------------------------------------------------------------ family inbox (forwarded emails)
export function inboxAddress(token: string) {
  const base = Deno.env.get("POSTMARK_INBOUND_ADDRESS") ?? ""; // like abc123@inbound.postmarkapp.com
  if (!base.includes("@")) return null;
  const [local, domain] = base.split("@");
  return `${local}+${token}@${domain}`;
}

/** A forwarded email arrived for a household. Gmail forwarding codes are passed to the family; everything else is read like a school email. */
export async function handleFamilyEmail(token: string, m: { messageId: string; from: string; fromName: string; subject: string; text: string; date: string }) {
  const db = admin();
  const { data: src } = await db.from("family_sources").select("*").eq("token", token).eq("kind", "email").maybeSingle();
  if (!src) return { ignored: "unknown address" };
  const { count } = await db.from("family_proposals").select("id", { count: "exact", head: true }).eq("household_id", src.household_id).like("source_ref", "email:%").gt("created_at", new Date(Date.now() - 864e5).toISOString());
  if ((count ?? 0) > 60) return { ignored: "daily limit" };

  // Gmail and Outlook send a confirmation code before forwarding starts: hand it to the family
  if (/forwarding confirmation|confirm.*forward|verify.*forward/i.test(m.subject)) {
    const code = m.text.match(/\b\d{6,9}\b/)?.[0];
    const link = m.text.match(/https:\/\/[^\s>"]*(mail\.google|outlook|live)\.com[^\s>"]*/i)?.[0];
    await postToThread(src.household_id, `📨 Email forwarding is almost set up.${code ? ` Your confirmation code is **${code}**.` : ""}${link ? `\nOr confirm here: ${link}` : ""}\nEnter it in your email settings to finish.`, { source_id: src.id });
    return { forwarded_confirmation: true };
  }
  await db.from("family_sources").update({ last_synced_at: new Date().toISOString(), events_count: (src.events_count ?? 0) + 1 }).eq("id", src.id);
  const { data: owner } = await db.from("profiles").select("timezone").eq("id", src.created_by).maybeSingle();
  const f = src.created_by ? await getFamily(src.created_by) : null;
  if (!f) return { ignored: "no adult" };
  const id = await schoolEmail(src.created_by, owner?.timezone ?? "America/Los_Angeles", {
    id: `fwd:${m.messageId}`, threadId: "", from: m.from, fromName: m.fromName || m.from, fromEmail: m.from, to: "", subject: m.subject,
    date: m.date, snippet: clip(m.text, 200), body: clip(m.text, 6000), messageId: m.messageId, labels: [], receivedAt: new Date().toISOString(),
  }, `the family inbox (${src.name})`);
  return { proposal: id };
}
