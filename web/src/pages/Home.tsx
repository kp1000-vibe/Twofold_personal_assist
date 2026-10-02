import { useEffect, useMemo, useState } from "react";
import { ErrorBox, Loading, must, Profile, supabase, useLoad } from "../lib";
import { enablePush, pushEnabledHere, pushSupported } from "../push";
import WeekCheck from "./WeekCheck";

type Member = { id: string; household_id: string; user_id: string | null; role: string; name: string; color: string | null };
type Item = { id: string; list_id: string; text: string; done: boolean; assigned_to: string | null; due_at: string | null; repeat: string | null; lists: { title: string; kind: string; shared: boolean; owner_id: string } };
type Ev = { id: string; title: string; start_at: string; member_ids: string[]; needs_driver: boolean; driver_id: string | null; location: string | null };

const COLORS = ["#E8A33D", "#5B8DEF", "#3FB68B", "#E36B6B", "#A77BDB", "#E88BB8", "#4FB3BF", "#8C9A5B"];
const WHEN: Record<string, string> = { none: "Anytime", now: "In 1 hour", tonight: "Tonight 7 pm", morning: "Tomorrow 8 am", pick: "Pick a time" };

function whenToIso(w: string, custom: string): string | null {
  const d = new Date();
  if (w === "now") return new Date(Date.now() + 3600_000).toISOString();
  if (w === "tonight") { d.setHours(19, 0, 0, 0); if (d < new Date()) d.setDate(d.getDate() + 1); return d.toISOString(); }
  if (w === "morning") { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.toISOString(); }
  if (w === "pick" && custom) return new Date(custom).toISOString();
  return null;
}
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };

/** The first screen: what this family needs to do today, and one box to add more. */
export default function Home({ profile }: { profile: Profile }) {
  const fam = useLoad(async () => {
    const { data: me } = await supabase.from("household_members").select("*").eq("user_id", profile.id).maybeSingle();
    if (!me) return null;
    const { data: members } = await supabase.from("household_members").select("*").eq("household_id", me.household_id).order("joined_at");
    return { me: me as Member, members: (members ?? []) as Member[] };
  });
  const items = useLoad(async () => must(await supabase.from("list_items").select("*, lists!inner(title, kind, shared, owner_id)").eq("done", false).order("due_at", { ascending: true, nullsFirst: false }).limit(200)) as Item[]);
  const rides = useLoad(async () => must(await supabase.from("family_events").select("*").gte("start_at", new Date().toISOString()).lte("start_at", new Date(Date.now() + 2 * 864e5).toISOString()).order("start_at")) as Ev[]);
  const streaks = useLoad(async () => {
    const { data } = await supabase.rpc("chore_streaks");
    return (data ?? []) as { member_id: string; streak: number; done_today: number }[];
  });
  const pushOn = useLoad(pushEnabledHere);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [text, setText] = useState("");
  const [who, setWho] = useState("");
  const [when, setWhen] = useState("none");
  const [custom, setCustom] = useState("");
  const [repeat, setRepeat] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [celebrate, setCelebrate] = useState<string | null>(null);

  const reloadAll = () => { items.reload(); streaks.reload(); rides.reload(); };
  useEffect(() => {
    const ch = supabase.channel("home-items").on("postgres_changes", { event: "*", schema: "public", table: "list_items" }, () => { items.reload(); streaks.reload(); }).subscribe();
    window.addEventListener("twofold:resume", reloadAll);
    return () => { supabase.removeChannel(ch); window.removeEventListener("twofold:resume", reloadAll); };
  }, []);

  const f = fam.data;
  const me = f?.me;
  const members = f?.members ?? [];
  const colorOf = (id: string | null) => { const i = members.findIndex((m) => m.id === id); return i >= 0 ? members[i].color ?? COLORS[i % COLORS.length] : "var(--line)"; };
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.name;

  const today = useMemo(() => {
    const end = endOfToday();
    return (items.data ?? []).filter((i) => {
      const dueOk = !i.due_at || new Date(i.due_at) <= end;
      const relevant = i.lists.kind === "chores" || i.lists.kind === "todo" || !!i.due_at;
      const mine = !me || i.assigned_to === me.id || (!i.assigned_to && (i.lists.shared ? true : i.lists.owner_id === profile.id));
      return dueOk && relevant && (scope === "all" || mine);
    });
  }, [items.data, scope, me?.id]);
  const later = useMemo(() => (items.data ?? []).filter((i) => i.due_at && new Date(i.due_at) > endOfToday() && (scope === "all" || !me || i.assigned_to === me.id || !i.assigned_to)).slice(0, 8), [items.data, scope, me?.id]);
  const groceries = (items.data ?? []).filter((i) => i.lists.kind === "grocery").length;
  const needDriver = (rides.data ?? []).filter((e) => e.needs_driver && !e.driver_id);

  const toggle = async (i: Item) => {
    const { error } = await supabase.from("list_items").update({ done: true }).eq("id", i.id);
    if (error) return setErr(error.message);
    setCelebrate(i.repeat ? `Done! Back ${i.repeat === "daily" ? "tomorrow" : i.repeat === "weekly" ? "next week" : "next month"}.` : "Done!");
    setTimeout(() => setCelebrate(null), 1800);
    items.reload(); streaks.reload();
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    try {
      // everything quick added goes to the shared "Family to do" list (or a private "My to do" without a household)
      const shared = !!me;
      const title = shared ? "Family to do" : "My to do";
      let { data: list } = await supabase.from("lists").select("id").eq("title", title).eq(shared ? "shared" : "owner_id", shared ? true : profile.id).limit(1).maybeSingle();
      if (!list) {
        const { data, error } = await supabase.from("lists").insert({ owner_id: profile.id, household_id: me?.household_id ?? null, title, kind: "chores", shared }).select("id").single();
        if (error) throw error;
        list = data;
      }
      const due = whenToIso(when, custom) ?? (repeat ? whenToIso("tonight", "") : null);
      const { error } = await supabase.from("list_items").insert({ list_id: list!.id, text: text.trim(), added_by: profile.id, assigned_to: who || null, due_at: due, repeat: repeat || null });
      if (error) throw error;
      setText(""); setWhen("none"); setRepeat(""); setCustom("");
      items.reload();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const claimRide = async (ev: Ev) => {
    if (!me) return;
    const { error } = await supabase.from("family_events").update({ driver_id: me.id }).eq("id", ev.id);
    if (error) setErr(error.message);
    rides.reload();
  };

  const hello = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
  const done = (streaks.data ?? []).find((s) => s.member_id === me?.id);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{hello}{profile.display_name ? `, ${profile.display_name}` : ""}</h1>
          <p>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}{done?.done_today ? ` · you finished ${done.done_today} today` : ""}</p>
        </div>
      </div>

      {fam.loading ? <Loading /> : !f && (
        <a href="#/family" className="card" style={{ display: "block", textDecoration: "none", borderLeft: "4px solid var(--gold)" }}>
          <strong>Set up your family</strong>
          <div className="ink2">Create your household and invite your partner and teens. Then chores and reminders reach the right person.</div>
        </a>
      )}

      {pushSupported() && pushOn.data === false && (
        <div className="notice row spread wrap" style={{ marginBottom: 12 }}>
          <span>Turn on notifications so reminders actually reach you.</span>
          <button className="btn sm primary" onClick={async () => { const m = await enablePush(profile.id); if (m) setErr(m); pushOn.reload(); }}>Turn on</button>
        </div>
      )}

      {/* quick add */}
      <form className="card" onSubmit={add} style={{ padding: 12 }}>
        <div className="row">
          <input className="input grow" placeholder="Add a chore or reminder, like Take out trash" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} />
          <button className="btn primary" disabled={busy || !text.trim()}>Add</button>
        </div>
        {text.trim() && (
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            {members.length > 0 && (
              <select className="input" style={{ width: "auto" }} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who">
                <option value="">Anyone</option>{members.map((m) => <option key={m.id} value={m.id}>{m.id === me?.id ? "Me" : m.name}</option>)}
              </select>
            )}
            <select className="input" style={{ width: "auto" }} value={when} onChange={(e) => setWhen(e.target.value)} aria-label="When">
              {Object.entries(WHEN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {when === "pick" && <input className="input" style={{ width: "auto" }} type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />}
            <select className="input" style={{ width: "auto" }} value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-label="Repeat">
              <option value="">Once</option><option value="daily">Every day</option><option value="weekly">Every week</option><option value="monthly">Every month</option>
            </select>
          </div>
        )}
      </form>
      {celebrate && <div className="success" style={{ marginBottom: 12 }}>✅ {celebrate}</div>}
      <ErrorBox msg={err} />

      {/* rides */}
      {needDriver.length > 0 && (
        <div className="card" style={{ borderLeft: "4px solid var(--warn)" }}>
          <strong>🚗 Rides with no driver</strong>
          {needDriver.map((e) => (
            <div key={e.id} className="item">
              <div className="grow"><div className="title">{e.title}</div><div className="sub">{new Date(e.start_at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })} · {e.member_ids.map(nameOf).filter(Boolean).join(", ")}</div></div>
              {me && (me.role === "owner" || me.role === "adult") && <button className="btn sm gold" onClick={() => claimRide(e)}>I will drive</button>}
            </div>
          ))}
        </div>
      )}

      {/* today */}
      <div className="row spread" style={{ margin: "18px 0 8px" }}>
        <h2 style={{ margin: 0 }}>Today</h2>
        {f && (
          <div className="row" style={{ gap: 4 }}>
            <button className={`btn sm ${scope === "mine" ? "primary" : "ghost"}`} onClick={() => setScope("mine")}>Mine</button>
            <button className={`btn sm ${scope === "all" ? "primary" : "ghost"}`} onClick={() => setScope("all")}>Everyone</button>
          </div>
        )}
      </div>
      <div className="card" style={{ padding: "4px 12px" }}>
        {items.loading ? <Loading /> : today.length === 0 ? (
          <p className="muted" style={{ padding: "10px 0" }}>Nothing due today. Add a chore above, or ask in the family chat.</p>
        ) : today.map((i) => {
          const overdue = i.due_at && new Date(i.due_at) < new Date();
          return (
            <label key={i.id} className="item" style={{ cursor: "pointer", alignItems: "center" }}>
              <input type="checkbox" checked={false} onChange={() => toggle(i)} style={{ width: 24, height: 24, flex: "none" }} />
              <div className="grow">
                <div className="title">{i.text}</div>
                <div className="sub">
                  {[i.due_at && new Date(i.due_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), i.repeat && `every ${i.repeat === "daily" ? "day" : i.repeat === "weekly" ? "week" : "month"}`, i.lists.title].filter(Boolean).join(" · ")}
                  {overdue && <span className="chip warn" style={{ marginLeft: 6 }}>late</span>}
                </div>
              </div>
              {i.assigned_to && <span className="chip" style={{ background: `${colorOf(i.assigned_to)}22` }}>{i.assigned_to === me?.id ? "you" : nameOf(i.assigned_to)}</span>}
            </label>
          );
        })}
      </div>

      {later.length > 0 && (
        <>
          <h3 style={{ margin: "16px 0 6px" }}>Coming up</h3>
          <div className="card" style={{ padding: "4px 12px" }}>
            {later.map((i) => (
              <div key={i.id} className="item">
                <div className="grow"><div className="title">{i.text}</div><div className="sub">{new Date(i.due_at!).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })}{i.assigned_to ? ` · ${i.assigned_to === me?.id ? "you" : nameOf(i.assigned_to)}` : ""}</div></div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* streaks */}
      {f && (streaks.data ?? []).some((s) => s.streak > 0 || s.done_today > 0) && (
        <div className="card">
          <strong>Streaks</strong>
          <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
            {(streaks.data ?? []).filter((s) => s.streak > 0 || s.done_today > 0).sort((a, b) => b.streak - a.streak).map((s) => (
              <span key={s.member_id} className="chip" style={{ background: `${colorOf(s.member_id)}22`, fontSize: 14 }}>
                {s.streak >= 3 ? "🔥" : "⭐"} {nameOf(s.member_id)} · {s.streak} day{s.streak === 1 ? "" : "s"}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="row wrap" style={{ gap: 8, margin: "14px 0" }}>
        <a className="btn" href="#/family?tab=lists">🛒 Groceries{groceries ? ` (${groceries})` : ""}</a>
        <a className="btn" href="#/family?tab=calendar">📅 Family calendar</a>
        <a className="btn" href="#/family">💬 Family chat</a>
      </div>

      <WeekCheck />
    </div>
  );
}
