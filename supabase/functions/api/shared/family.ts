// Family: one household shares lists, chores, a calendar, expenses and a thread with Twofold.
// Private by default: only rows marked shared (or family tables) are visible to others.
import { admin, clip, localNow, Profile } from "./util.ts";
import { notify } from "./trust.ts";

export type Member = { id: string; household_id: string; user_id: string | null; role: string; name: string; share_calendar: string; birthday: string | null };
export type Family = { household: { id: string; name: string }; me: Member; members: Member[] };

export async function getFamily(userId: string): Promise<Family | null> {
  const db = admin();
  const { data: me } = await db.from("household_members").select("*").eq("user_id", userId).maybeSingle();
  if (!me) return null;
  const [{ data: household }, { data: members }] = await Promise.all([
    db.from("households").select("id, name").eq("id", me.household_id).single(),
    db.from("household_members").select("*").eq("household_id", me.household_id).order("joined_at"),
  ]);
  return { household: household!, me: me as Member, members: (members ?? []) as Member[] };
}

export const isAdult = (m: Member) => m.role === "owner" || m.role === "adult";

export function familyBrief(f: Family) {
  const who = f.members.map((m) => `${m.name} (${m.role === "kid" ? "kid, no login" : m.role}${m.id === f.me.id ? ", this is the user" : ""})`).join(", ");
  return `The user belongs to the household "${f.household.name}": ${who}. Family lists, chores, the family calendar${isAdult(f.me) ? ", shared expenses" : ""} and the family thread are shared with everyone in it. Their personal chats, email, memories and calendar are private and must never be shared with the family unless they explicitly ask.`;
}

function findMember(f: Family, name?: string | null): Member | null {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  if (["me", "i", "myself"].includes(n)) return f.me;
  return f.members.find((m) => m.name.toLowerCase() === n) ?? f.members.find((m) => m.name.toLowerCase().startsWith(n)) ?? null;
}

async function tellMembers(f: Family, memberIds: string[], row: { title: string; body?: string; link: string; why: string; importance?: number }) {
  for (const m of f.members) {
    if (!m.user_id || m.user_id === f.me.user_id || !memberIds.includes(m.id)) continue;
    await notify({ user_id: m.user_id, ...row, importance: row.importance ?? 1.8 });
  }
}

export async function postToThread(householdId: string, content: string, meta: Record<string, unknown> = {}, author?: { user: string; name: string }) {
  const { data } = await admin().from("family_messages").insert({
    household_id: householdId, author_user: author?.user ?? null, author_name: author?.name ?? "Twofold", content: clip(content, 3900), meta,
  }).select("id").single();
  return data?.id ?? null;
}

// ------------------------------------------------------------------ tools
const S = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = { type: "string" };
const strs = { type: "array", items: str };

export const FAMILY_TOOL_DEFS: Record<string, unknown> = {
  family_overview: { name: "family_overview", description: "See the household: members, shared lists with open items, family events in the next 7 days, and who did chores lately.", input_schema: S({}) },
  add_to_list: {
    name: "add_to_list", description: "Add items to a list, creating it if needed. Use kind grocery for shopping, chores for household chores. shared true puts it on the family list everyone sees; false keeps it private to the user. assign_to is a member name. repeat daily, weekly or monthly for recurring chores. due is ISO 8601.",
    input_schema: S({ list: str, kind: { type: "string", enum: ["grocery", "chores", "todo", "packing", "other"] }, shared: { type: "boolean" }, items: strs, assign_to: str, repeat: { type: "string", enum: ["daily", "weekly", "monthly"] }, due: str }, ["list", "items"]),
  },
  complete_list_item: { name: "complete_list_item", description: "Mark items done on a list by matching their text.", input_schema: S({ list: str, items: strs }, ["items"]) },
  create_family_event: {
    name: "create_family_event", description: "Put an event on the shared family calendar. who is a list of member names involved. needs_driver true when a kid must be driven; driver is a member name if known.",
    input_schema: S({ title: str, start: str, end: str, who: strs, location: str, needs_driver: { type: "boolean" }, driver: str, notes: str }, ["title", "start", "end"]),
  },
  set_driver: { name: "set_driver", description: "Assign who drives for a family event, by event title and member name.", input_schema: S({ event: str, driver: str }, ["event", "driver"]) },
  add_expense: {
    name: "add_expense", description: "Log a shared household expense (adults only). paid_by is a member name, default the user. split_among is member names, default all adults. recurring monthly or yearly for bills.",
    input_schema: S({ amount: { type: "number" }, description: str, paid_by: str, split_among: strs, category: str, recurring: { type: "string", enum: ["monthly", "yearly"] } }, ["amount", "description"]),
  },
  family_balances: { name: "family_balances", description: "Who owes whom on shared expenses that are not settled yet (adults only).", input_schema: S({}) },
  post_to_family: { name: "post_to_family", description: "Post a message to the family thread, only when the user asks you to tell or share something with the family.", input_schema: S({ message: str }, ["message"]) },
};
export const FAMILY_TOOLS = Object.keys(FAMILY_TOOL_DEFS);
export const TEEN_FAMILY_TOOLS = ["family_overview", "add_to_list", "complete_list_item", "create_family_event"];

export async function runFamilyTool(name: string, input: any, profile: Profile, f: Family): Promise<string> {
  const db = admin();
  const hid = f.household.id;
  const adult = isAdult(f.me);
  const tz = profile.timezone;
  switch (name) {
    case "family_overview": {
      const now = new Date().toISOString(), week = new Date(Date.now() + 7 * 864e5).toISOString();
      const [{ data: lists }, { data: events }, { data: chores }] = await Promise.all([
        db.from("lists").select("id, title, kind, list_items(text, done, assigned_to, due_at, repeat)").eq("household_id", hid).eq("shared", true),
        db.from("family_events").select("title, start_at, end_at, member_ids, needs_driver, driver_id, location").eq("household_id", hid).gte("end_at", now).lte("start_at", week).order("start_at"),
        db.from("chore_log").select("member_id").eq("household_id", hid).gt("done_at", new Date(Date.now() - 14 * 864e5).toISOString()),
      ]);
      const nm = (id: string | null) => f.members.find((m) => m.id === id)?.name ?? null;
      const counts: Record<string, number> = {};
      for (const c of chores ?? []) { const k = nm(c.member_id) ?? "someone"; counts[k] = (counts[k] ?? 0) + 1; }
      return JSON.stringify({
        household: f.household.name,
        members: f.members.map((m) => ({ name: m.name, role: m.role })),
        lists: (lists ?? []).map((l: any) => ({ title: l.title, kind: l.kind, open: (l.list_items ?? []).filter((i: any) => !i.done).map((i: any) => ({ text: i.text, for: nm(i.assigned_to), due: i.due_at, repeat: i.repeat })).slice(0, 40) })),
        next_7_days: (events ?? []).map((e) => ({ title: e.title, start: new Date(e.start_at).toLocaleString("en-US", { timeZone: tz }), who: e.member_ids.map(nm), driver: e.needs_driver ? (nm(e.driver_id) ?? "NOBODY YET") : undefined, location: e.location })),
        chores_done_last_14_days: counts,
      });
    }
    case "add_to_list": {
      const items = (Array.isArray(input.items) ? input.items : [input.items]).map((x: unknown) => String(x ?? "").trim()).filter(Boolean).slice(0, 40);
      if (!items.length) return "No items given";
      const title = String(input.list ?? "").trim().slice(0, 80) || (input.kind === "grocery" ? "Groceries" : "To do");
      const shared = input.shared !== false && (input.shared === true || ["grocery", "chores"].includes(input.kind));
      // prefer an existing list this user can see with the same name
      const { data: existing } = await db.from("lists").select("*").ilike("title", title)
        .or(`owner_id.eq.${profile.id},and(shared.eq.true,household_id.eq.${hid})`).limit(1);
      let list = existing?.[0];
      if (!list) {
        const { data, error } = await db.from("lists").insert({ owner_id: profile.id, household_id: hid, title, kind: input.kind ?? "todo", shared }).select().single();
        if (error) return `Could not create the list: ${error.message}`;
        list = data;
      }
      const who = findMember(f, input.assign_to);
      const due = input.due && !isNaN(new Date(input.due).getTime()) ? new Date(input.due).toISOString() : null;
      const { error } = await db.from("list_items").insert(items.map((text: string) => ({ list_id: list.id, text: text.slice(0, 200), added_by: profile.id, assigned_to: who?.id ?? null, repeat: input.repeat ?? null, due_at: due })));
      if (error) return `Could not add: ${error.message}`;
      if (who && list.shared) await tellMembers(f, [who.id], { title: `${f.me.name} gave you: ${items.slice(0, 3).join(", ")}`, body: `On ${list.title}`, link: "#/family?tab=lists", why: `${f.me.name} assigned it to you` });
      return `Added ${items.length} to "${list.title}" (${list.shared ? "shared with the family" : "private"})${who ? `, assigned to ${who.name}` : ""}${input.repeat ? `, repeats ${input.repeat}` : ""}.`;
    }
    case "complete_list_item": {
      const texts = (Array.isArray(input.items) ? input.items : [input.items]).map((x: unknown) => String(x ?? "").toLowerCase()).filter(Boolean);
      const { data: lists } = await db.from("lists").select("id, title").or(`owner_id.eq.${profile.id},and(shared.eq.true,household_id.eq.${hid})`);
      const ids = (lists ?? []).filter((l) => !input.list || l.title.toLowerCase().includes(String(input.list).toLowerCase())).map((l) => l.id);
      if (!ids.length) return "No matching list";
      const { data: open } = await db.from("list_items").select("id, text").in("list_id", ids).eq("done", false);
      const hits = (open ?? []).filter((i) => texts.some((t: string) => i.text.toLowerCase().includes(t)));
      for (const h of hits) {
        // the trigger logs the chore and uses done_by when there is no signed in user (service role)
        await db.from("list_items").update({ done: true, done_by: profile.id }).eq("id", h.id);
      }
      return hits.length ? `Marked done: ${hits.map((h) => h.text).join(", ")}` : "Nothing matched those items";
    }
    case "create_family_event": {
      const start = new Date(input.start), end = new Date(input.end);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return "Invalid start or end";
      const who = (Array.isArray(input.who) ? input.who : []).map((n: string) => findMember(f, n)).filter(Boolean) as Member[];
      const driver = findMember(f, input.driver);
      const { error } = await db.from("family_events").insert({
        household_id: hid, created_by: profile.id, title: String(input.title).slice(0, 120), start_at: start.toISOString(), end_at: end.toISOString(),
        location: input.location ?? null, member_ids: who.map((m) => m.id), needs_driver: !!input.needs_driver, driver_id: driver?.id ?? null, notes: input.notes ?? null,
      });
      if (error) return `Could not add: ${error.message}`;
      const when = start.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      await tellMembers(f, f.members.filter((m) => m.id !== f.me.id).map((m) => m.id), { title: `New on the family calendar: ${input.title}`, body: `${when}${input.needs_driver && !driver ? " · needs a driver" : ""}`, link: "#/family?tab=calendar", why: `${f.me.name} added it`, importance: input.needs_driver && !driver ? 2 : 1.2 });
      return `Added "${input.title}" on ${when} to the family calendar${who.length ? ` for ${who.map((m) => m.name).join(", ")}` : ""}${input.needs_driver ? (driver ? `, ${driver.name} drives` : ", nobody is driving yet") : ""}.`;
    }
    case "set_driver": {
      const d = findMember(f, input.driver);
      if (!d) return "No member with that name";
      const { data: ev } = await db.from("family_events").select("id, title, start_at").eq("household_id", hid).ilike("title", `%${input.event}%`).gte("end_at", new Date().toISOString()).order("start_at").limit(1).maybeSingle();
      if (!ev) return "No upcoming event with that title";
      await db.from("family_events").update({ driver_id: d.id }).eq("id", ev.id);
      await tellMembers(f, [d.id], { title: `You are driving: ${ev.title}`, body: new Date(ev.start_at).toLocaleString("en-US", { timeZone: tz }), link: "#/family?tab=calendar", why: `${f.me.name} set you as the driver`, importance: 2 });
      return `${d.name} is driving for "${ev.title}".`;
    }
    case "add_expense": {
      if (!adult) return "Only adults can see and add shared expenses.";
      const amount = Math.round(Number(input.amount) * 100) / 100;
      if (!(amount > 0)) return "Amount must be positive";
      const payer = findMember(f, input.paid_by) ?? f.me;
      const adults = f.members.filter(isAdult);
      const split = (Array.isArray(input.split_among) && input.split_among.length ? input.split_among.map((n: string) => findMember(f, n)).filter(Boolean) : adults) as Member[];
      const nextDue = input.recurring ? new Date(Date.now() + (input.recurring === "yearly" ? 365 : 30) * 864e5).toISOString().slice(0, 10) : null;
      const { error } = await db.from("expenses").insert({
        household_id: hid, created_by: profile.id, paid_by: payer.id, amount, description: String(input.description).slice(0, 160),
        category: input.category ?? null, split_among: split.map((m) => m.id), recurring: input.recurring ?? null, next_due: nextDue, spent_on: localNow(tz).date,
      });
      if (error) return `Could not log: ${error.message}`;
      const each = Math.round((amount / Math.max(split.length, 1)) * 100) / 100;
      await tellMembers(f, split.map((m) => m.id), { title: `${payer.name} paid ${amount} for ${input.description}`, body: `Your share is ${each}`, link: "#/family?tab=money", why: `${f.me.name} logged a shared expense`, importance: 1 });
      return `Logged ${amount} for "${input.description}", paid by ${payer.name}, split ${split.length} ways (${each} each).`;
    }
    case "family_balances": {
      if (!adult) return "Only adults can see shared expenses.";
      const { data: ex } = await db.from("expenses").select("paid_by, amount, split_among").eq("household_id", hid).eq("settled", false);
      const net: Record<string, number> = {};
      for (const e of ex ?? []) {
        net[e.paid_by] = (net[e.paid_by] ?? 0) + Number(e.amount);
        const share = Number(e.amount) / Math.max(e.split_among.length, 1);
        for (const m of e.split_among) net[m] = (net[m] ?? 0) - share;
      }
      return JSON.stringify(settle(f, net));
    }
    case "post_to_family": {
      await postToThread(hid, String(input.message ?? ""), { via: "assistant", for: f.me.name });
      return "Posted to the family thread.";
    }
  }
  return "Unknown family tool";
}

/** Who pays whom, fewest transfers. Pure arithmetic in code. */
export function settle(f: Family, net: Record<string, number>) {
  const nm = (id: string) => f.members.find((m) => m.id === id)?.name ?? "someone";
  const debtors = Object.entries(net).filter(([, v]) => v < -0.005).map(([k, v]) => ({ k, v: -v })).sort((a, b) => b.v - a.v);
  const creditors = Object.entries(net).filter(([, v]) => v > 0.005).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
  const transfers: { from: string; to: string; amount: number }[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].v, creditors[j].v);
    transfers.push({ from: nm(debtors[i].k), to: nm(creditors[j].k), amount: Math.round(pay * 100) / 100 });
    debtors[i].v -= pay; creditors[j].v -= pay;
    if (debtors[i].v < 0.005) i++;
    if (creditors[j].v < 0.005) j++;
  }
  return { net: Object.fromEntries(Object.entries(net).map(([k, v]) => [nm(k), Math.round(v * 100) / 100])), transfers };
}
