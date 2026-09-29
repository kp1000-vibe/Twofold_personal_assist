import { useEffect, useMemo, useRef, useState } from "react";
import { ago, Empty, ErrorBox, fn, Loading, Markdown, must, Profile, supabase, useLoad, usd } from "../lib";

type Member = { id: string; household_id: string; user_id: string | null; role: "owner" | "adult" | "teen" | "kid"; name: string; color: string | null; birthday: string | null };
type House = { id: string; name: string };
type Tab = "home" | "lists" | "calendar" | "money" | "people";

const COLORS = ["#E8A33D", "#5B8DEF", "#3FB68B", "#E36B6B", "#A77BDB", "#E88BB8", "#4FB3BF", "#8C9A5B"];
const colorOf = (m: Member, i: number) => m.color ?? COLORS[i % COLORS.length];
const isAdult = (m?: Member | null) => !!m && (m.role === "owner" || m.role === "adult");

export default function Family({ profile, params }: { profile: Profile; params: URLSearchParams }) {
  const fam = useLoad(async () => {
    const { data: me } = await supabase.from("household_members").select("*").eq("user_id", profile.id).maybeSingle();
    if (!me) return null;
    const [{ data: house }, { data: members }] = await Promise.all([
      supabase.from("households").select("*").eq("id", me.household_id).single(),
      supabase.from("household_members").select("*").eq("household_id", me.household_id).order("joined_at"),
    ]);
    return { me: me as Member, house: house as House, members: (members ?? []) as Member[] };
  });
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) ?? "home");
  useEffect(() => { const t = params.get("tab") as Tab; if (t) setTab(t); }, [params]);

  if (fam.loading) return <Loading />;
  if (!fam.data) return <NoHousehold onDone={fam.reload} />;
  const { me, house, members } = fam.data;
  const tabs: [Tab, string][] = [["home", "Family chat"], ["lists", "Lists and chores"], ["calendar", "Calendar"], ...(isAdult(me) ? [["money", "Money"] as [Tab, string]] : []), ["people", "People"]];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{house.name}</h1>
          <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>
            {members.map((m, i) => (
              <span key={m.id} className="chip" style={{ background: `${colorOf(m, i)}22`, color: "var(--ink)" }}>
                <span className="dot" style={{ background: colorOf(m, i), marginRight: 6 }} />{m.name}{m.role === "kid" ? " (kid)" : m.role === "teen" ? " (teen)" : ""}
              </span>
            ))}
          </div>
        </div>
        {isAdult(me) && <button className="btn" onClick={() => setTab("people")}>Invite</button>}
      </div>
      <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}>
        {tabs.map(([k, label]) => <button key={k} className={`btn sm ${tab === k ? "primary" : "ghost"}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === "home" && <Thread me={me} house={house} members={members} />}
      {tab === "lists" && <Lists me={me} house={house} members={members} profile={profile} />}
      {tab === "calendar" && <Calendar me={me} house={house} members={members} profile={profile} />}
      {tab === "money" && isAdult(me) && <Money me={me} house={house} members={members} profile={profile} />}
      {tab === "people" && <People me={me} members={members} onChange={fam.reload} />}
    </div>
  );
}

// ------------------------------------------------------------------ no household yet
function NoHousehold({ onDone }: { onDone: () => void }) {
  const saved = localStorage.getItem("twofold_invite") ?? "";
  const [name, setName] = useState("");
  const [code, setCode] = useState(saved.startsWith("FAM") ? saved : "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => PromiseLike<{ error: any }>) => {
    setBusy(true); setErr(null);
    const { error } = await f();
    setBusy(false);
    if (error) return setErr(error.message);
    localStorage.removeItem("twofold_invite");
    onDone();
  };
  return (
    <div>
      <div className="page-head"><div><h1>Family</h1><p>One shared home base: groceries, chores, pickups, bills and a family chat where Twofold helps everyone.</p></div></div>
      <div className="grid cols-3">
        <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => supabase.rpc("create_household", { p_name: name })); }}>
          <h2>Start your household</h2>
          <label className="field"><span>Family name</span><input className="input" placeholder="The Patros" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></label>
          <button className="btn primary" disabled={busy || !name.trim()}>Create</button>
        </form>
        <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => supabase.rpc("join_household", { p_code: code })); }}>
          <h2>Join with an invite</h2>
          <label className="field"><span>Family invite code</span><input className="input mono" style={{ textTransform: "uppercase" }} placeholder="FAM1A2B3C4D" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
          <button className="btn" disabled={busy || !code.trim()}>Join</button>
        </form>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>What stays private</h3>
        <p className="ink2" style={{ margin: 0 }}>Your chats with Twofold, email, calendar, memories and personal lists stay yours. Only what you put on family lists, the family calendar, shared expenses or the family chat is seen by the household.</p>
      </div>
      <ErrorBox msg={err} />
    </div>
  );
}

// ------------------------------------------------------------------ family chat
type Msg = { id: string; author_user: string | null; author_name: string; content: string; meta: any; created_at: string };
function Thread({ me, house, members }: { me: Member; house: House; members: Member[] }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    supabase.from("family_messages").select("*").order("created_at", { ascending: false }).limit(80).then(({ data }) => setMsgs(((data ?? []) as Msg[]).reverse()));
    const ch = supabase.channel("family-thread")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "family_messages", filter: `household_id=eq.${house.id}` }, (p: any) => {
        setMsgs((cur) => (cur.some((x) => x.id === p.new.id) ? cur : [...cur, p.new as Msg]));
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [house.id]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);

  const send = async (ask: boolean) => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setErr(null); setText("");
    try { await fn("family-chat", { message: t, ask }); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setText(t); } finally { setBusy(false); }
  };
  const color = (uid: string | null) => { const i = members.findIndex((m) => m.user_id === uid); return i >= 0 ? colorOf(members[i], i) : "var(--gold)"; };
  const ideas = ["Add milk, eggs and bread to groceries", "Who is driving to soccer on Saturday?", "Split the Costco run, $142, I paid", "Make a weekly chore chart for the kids"];

  return (
    <div className="chat" style={{ height: "calc(100vh - 220px)", minHeight: 420 }}>
      <div className="chat-log" ref={logRef}>
        {msgs.length === 0 && (
          <div className="empty" style={{ paddingTop: 40 }}>
            <div className="big">Your family chat, with Twofold in it</div>
            <p className="muted">Ask Twofold for anything the house needs. It only uses shared family info here, never anyone's private stuff.</p>
            <div className="suggest">{ideas.map((s) => <button key={s} onClick={() => setText(s)}>{s}</button>)}</div>
          </div>
        )}
        {msgs.map((m) => {
          const mine = m.author_user === me.user_id;
          const bot = !m.author_user;
          return (
            <div key={m.id} className={`msg ${mine ? "user" : "assistant"}`}>
              <div className="bubble">
                {!mine && <div style={{ fontSize: 12, fontWeight: 600, color: bot ? "var(--gold)" : color(m.author_user), marginBottom: 4 }}>{bot ? "Twofold (AI)" : m.author_name}</div>}
                {bot ? <Markdown text={m.content} /> : m.content}
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{ago(m.created_at)}</div>
              </div>
            </div>
          );
        })}
        {busy && <div className="msg assistant"><div className="bubble"><span className="thinking"><i /><i /> Twofold is on it</span></div></div>}
        <ErrorBox msg={err} />
      </div>
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(true); }}>
        <textarea rows={1} value={text} placeholder="Message the family" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(true); } }} />
        <button type="button" className="btn" disabled={busy || !text.trim()} onClick={() => send(false)} title="Just post, no AI">Post</button>
        <button className="btn primary" disabled={busy || !text.trim()} title="Post and ask Twofold">Ask Twofold</button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ lists and chores
type List = { id: string; owner_id: string; title: string; kind: string; shared: boolean };
type Item = { id: string; list_id: string; text: string; done: boolean; assigned_to: string | null; due_at: string | null; repeat: string | null; done_at: string | null };
function Lists({ me, house, members, profile }: { me: Member; house: House; members: Member[]; profile: Profile }) {
  const lists = useLoad(async () => must(await supabase.from("lists").select("*").order("created_at")) as List[]);
  const [sel, setSel] = useState<string | null>(null);
  const cur = (lists.data ?? []).find((l) => l.id === sel) ?? (lists.data ?? [])[0];
  const items = useLoad(async () => (cur ? must(await supabase.from("list_items").select("*").eq("list_id", cur.id).order("done").order("created_at")) as Item[] : []), [cur?.id]);
  const log = useLoad(async () => must(await supabase.from("chore_log").select("member_id").gt("done_at", new Date(Date.now() - 14 * 864e5).toISOString())) as { member_id: string | null }[]);
  const [newItem, setNewItem] = useState("");
  const [assign, setAssign] = useState("");
  const [repeat, setRepeat] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("grocery");
  const [shared, setShared] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!cur) return;
    const ch = supabase.channel(`items-${cur.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "list_items", filter: `list_id=eq.${cur.id}` }, () => { items.reload(); log.reload(); })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [cur?.id]);

  const createList = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const { data, error } = await supabase.from("lists").insert({ owner_id: profile.id, household_id: house.id, title: title.trim(), kind, shared }).select().single();
    if (error) return setErr(error.message);
    setTitle(""); await lists.reload(); setSel((data as List).id);
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); if (!cur || !newItem.trim()) return; setErr(null);
    const rows = newItem.split(/,|\n/).map((t) => t.trim()).filter(Boolean).map((t) => ({ list_id: cur.id, text: t, added_by: profile.id, assigned_to: assign || null, repeat: repeat || null }));
    const { error } = await supabase.from("list_items").insert(rows);
    if (error) return setErr(error.message);
    setNewItem(""); items.reload();
  };
  const toggle = async (i: Item) => { await supabase.from("list_items").update({ done: !i.done }).eq("id", i.id); items.reload(); log.reload(); };
  const remove = async (i: Item) => { await supabase.from("list_items").delete().eq("id", i.id); items.reload(); };
  const clearDone = async () => { if (cur) { await supabase.from("list_items").delete().eq("list_id", cur.id).eq("done", true); items.reload(); } };
  const toggleShare = async () => { if (cur) { await supabase.from("lists").update({ shared: !cur.shared }).eq("id", cur.id); lists.reload(); } };

  const nm = (id: string | null) => members.find((m) => m.id === id)?.name;
  const board = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of log.data ?? []) if (l.member_id) c[l.member_id] = (c[l.member_id] ?? 0) + 1;
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    return { total, rows: members.map((m, i) => ({ m, i, n: c[m.id] ?? 0 })).filter((r) => r.n > 0).sort((a, b) => b.n - a.n) };
  }, [log.data, members]);

  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(200px, 260px) 1fr", alignItems: "start" }}>
      <div className="stack">
        <div className="card" style={{ padding: 8 }}>
          {(lists.data ?? []).map((l) => (
            <button key={l.id} className={`nav-item ${cur?.id === l.id ? "active" : ""}`} style={{ width: "100%", border: 0, background: "none", cursor: "pointer" }} onClick={() => setSel(l.id)}>
              <span>{l.kind === "grocery" ? "🛒" : l.kind === "chores" ? "🧹" : l.kind === "packing" ? "🧳" : "📝"}</span>{l.title}
              {!l.shared && <span className="chip" style={{ marginLeft: "auto" }}>private</span>}
            </button>
          ))}
          {!lists.loading && !lists.data?.length && <p className="muted" style={{ padding: 8 }}>No lists yet</p>}
        </div>
        <form className="card" onSubmit={createList}>
          <h3 style={{ marginTop: 0 }}>New list</h3>
          <input className="input" placeholder="Groceries" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={80} />
          <select className="input" style={{ marginTop: 8 }} value={kind} onChange={(e) => { setKind(e.target.value); setShared(["grocery", "chores"].includes(e.target.value)); }}>
            <option value="grocery">Groceries</option><option value="chores">Chores</option><option value="todo">To do</option><option value="packing">Packing</option><option value="other">Other</option>
          </select>
          <label className="row" style={{ margin: "8px 0" }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /><span>Share with the family</span></label>
          <button className="btn sm primary">Create</button>
        </form>
        {board.total > 0 && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Chores, last 2 weeks</h3>
            {board.rows.map((r) => (
              <div key={r.m.id} style={{ marginBottom: 8 }}>
                <div className="row spread"><small>{r.m.name}</small><small>{r.n} · {Math.round((r.n / board.total) * 100)}%</small></div>
                <div style={{ height: 6, borderRadius: 6, background: "var(--surface-2)" }}><div style={{ height: "100%", width: `${(r.n / board.total) * 100}%`, borderRadius: 6, background: colorOf(r.m, r.i) }} /></div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        {!cur ? <Empty title="Make your first list">Groceries and chores are shared with the family by default.</Empty> : (
          <>
            <div className="row spread wrap" style={{ marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>{cur.title}</h2>
              <div className="row" style={{ gap: 6 }}>
                {cur.owner_id === profile.id && <button className="btn ghost sm" onClick={toggleShare}>{cur.shared ? "Shared with family" : "Private"} · change</button>}
                <button className="btn ghost sm" onClick={clearDone}>Clear done</button>
              </div>
            </div>
            <form className="row wrap" onSubmit={add} style={{ marginBottom: 12 }}>
              <input className="input grow" style={{ minWidth: 180 }} placeholder={cur.kind === "chores" ? "Take out trash, dishes" : "Milk, eggs, bread"} value={newItem} onChange={(e) => setNewItem(e.target.value)} />
              {cur.shared && (
                <select className="input" style={{ width: "auto" }} value={assign} onChange={(e) => setAssign(e.target.value)}>
                  <option value="">Anyone</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              )}
              {cur.kind === "chores" && (
                <select className="input" style={{ width: "auto" }} value={repeat} onChange={(e) => setRepeat(e.target.value)}>
                  <option value="">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                </select>
              )}
              <button className="btn primary">Add</button>
            </form>
            {items.loading ? <Loading /> : (items.data ?? []).length === 0 ? <p className="muted">Nothing here yet. Tip: separate items with commas, or ask Twofold in the family chat.</p> : (items.data ?? []).map((i) => (
              <div key={i.id} className="item" style={{ opacity: i.done ? 0.5 : 1 }}>
                <input type="checkbox" checked={i.done} onChange={() => toggle(i)} style={{ width: 20, height: 20 }} />
                <div className="grow">
                  <div className="title" style={{ textDecoration: i.done ? "line-through" : "none" }}>{i.text}</div>
                  <div className="sub">{[nm(i.assigned_to), i.repeat && `repeats ${i.repeat}`, i.due_at && `due ${new Date(i.due_at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`].filter(Boolean).join(" · ")}</div>
                </div>
                <button className="btn ghost sm" onClick={() => remove(i)} title="Remove">×</button>
              </div>
            ))}
          </>
        )}
        <ErrorBox msg={err} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ calendar
type Ev = { id: string; title: string; start_at: string; end_at: string; all_day: boolean; location: string | null; member_ids: string[]; needs_driver: boolean; driver_id: string | null; created_by: string };
function Calendar({ me, house, members, profile }: { me: Member; house: House; members: Member[]; profile: Profile }) {
  const evs = useLoad(async () => must(await supabase.from("family_events").select("*").gte("end_at", new Date(Date.now() - 864e5).toISOString()).lte("start_at", new Date(Date.now() + 21 * 864e5).toISOString()).order("start_at")) as Ev[]);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [start, setStart] = useState("15:00");
  const [end, setEnd] = useState("16:00");
  const [who, setWho] = useState<string[]>([]);
  const [needsDriver, setNeedsDriver] = useState(false);
  const [loc, setLoc] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ch = supabase.channel("family-cal").on("postgres_changes", { event: "*", schema: "public", table: "family_events", filter: `household_id=eq.${house.id}` }, () => evs.reload()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [house.id]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const s = new Date(`${date}T${start}`), en = new Date(`${date}T${end}`);
    if (en < s) return setErr("End is before start");
    const { error } = await supabase.from("family_events").insert({ household_id: house.id, created_by: profile.id, title: title.trim(), start_at: s.toISOString(), end_at: en.toISOString(), member_ids: who, needs_driver: needsDriver, location: loc.trim() || null });
    if (error) return setErr(error.message);
    setTitle(""); setWho([]); setNeedsDriver(false); setLoc(""); setOpen(false); evs.reload();
  };
  const drive = async (ev: Ev) => { const { error } = await supabase.from("family_events").update({ driver_id: me.id }).eq("id", ev.id); if (error) setErr(error.message); evs.reload(); };
  const del = async (ev: Ev) => { if (confirm(`Remove ${ev.title}?`)) { await supabase.from("family_events").delete().eq("id", ev.id); evs.reload(); } };
  const nm = (id: string | null) => members.find((m) => m.id === id)?.name;

  const days = useMemo(() => {
    const g = new Map<string, Ev[]>();
    for (const e of evs.data ?? []) {
      const k = new Date(e.start_at).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(e);
    }
    return [...g.entries()];
  }, [evs.data]);
  const gaps = (evs.data ?? []).filter((e) => e.needs_driver && !e.driver_id && new Date(e.start_at) > new Date());

  return (
    <div>
      {gaps.length > 0 && <div className="notice" style={{ marginBottom: 12 }}>🚗 {gaps.length} ride{gaps.length > 1 ? "s" : ""} still need{gaps.length > 1 ? "" : "s"} a driver: {gaps.map((g) => g.title).join(", ")}</div>}
      <div className="row spread" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Next 3 weeks</h2>
        <button className="btn primary sm" onClick={() => setOpen(!open)}>{open ? "Close" : "Add event"}</button>
      </div>
      {open && (
        <form className="card" onSubmit={add}>
          <div className="row wrap">
            <label className="field grow"><span>What</span><input className="input" placeholder="Soccer practice" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} /></label>
            <label className="field"><span>Day</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <label className="field"><span>From</span><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="field"><span>To</span><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
          <label className="field"><span>Where (optional)</span><input className="input" value={loc} onChange={(e) => setLoc(e.target.value)} /></label>
          <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
            <small className="muted">Who:</small>
            {members.map((m) => (
              <label key={m.id} className="chip" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={who.includes(m.id)} onChange={(e) => setWho(e.target.checked ? [...who, m.id] : who.filter((x) => x !== m.id))} style={{ marginRight: 4 }} />{m.name}
              </label>
            ))}
          </div>
          <label className="row" style={{ marginBottom: 10 }}><input type="checkbox" checked={needsDriver} onChange={(e) => setNeedsDriver(e.target.checked)} /><span>Someone needs to drive</span></label>
          <button className="btn primary">Add to family calendar</button>
        </form>
      )}
      {evs.loading ? <Loading /> : days.length === 0 ? <div className="card"><Empty title="Nothing on the family calendar">Add practices, pickups, trips and dinners. Or say "@twofold soccer every Tuesday at 4, Ria needs a ride" in the family chat.</Empty></div> : days.map(([day, list]) => (
        <div key={day} className="card" style={{ padding: "8px 14px" }}>
          <div className="muted" style={{ fontSize: 13, fontWeight: 600, margin: "6px 0" }}>{day}</div>
          {list.map((e) => (
            <div key={e.id} className="item">
              <div style={{ width: 70 }}><small>{e.all_day ? "All day" : new Date(e.start_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</small></div>
              <div className="grow">
                <div className="title">{e.title}</div>
                <div className="sub">{[e.member_ids.map(nm).filter(Boolean).join(", "), e.location].filter(Boolean).join(" · ")}</div>
              </div>
              {e.needs_driver && (e.driver_id ? <span className="chip good">🚗 {nm(e.driver_id)}</span> : isAdult(me) ? <button className="btn sm gold" onClick={() => drive(e)}>I will drive</button> : <span className="chip warn">needs driver</span>)}
              {(e.created_by === profile.id || isAdult(me)) && <button className="btn ghost sm" onClick={() => del(e)}>×</button>}
            </div>
          ))}
        </div>
      ))}
      <ErrorBox msg={err} />
    </div>
  );
}

// ------------------------------------------------------------------ money
type Expense = { id: string; paid_by: string; amount: number; description: string; spent_on: string; split_among: string[]; recurring: string | null; settled: boolean };
function Money({ me, house, members, profile }: { me: Member; house: House; members: Member[]; profile: Profile }) {
  const adults = members.filter(isAdult);
  const list = useLoad(async () => must(await supabase.from("expenses").select("*").order("spent_on", { ascending: false }).order("created_at", { ascending: false }).limit(60)) as Expense[]);
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [paidBy, setPaidBy] = useState(me.id);
  const [split, setSplit] = useState<string[]>(adults.map((m) => m.id));
  const [recurring, setRecurring] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const nm = (id: string) => members.find((m) => m.id === id)?.name ?? "someone";

  const open = (list.data ?? []).filter((e) => !e.settled);
  const transfers = useMemo(() => {
    const net: Record<string, number> = {};
    for (const e of open) {
      net[e.paid_by] = (net[e.paid_by] ?? 0) + Number(e.amount);
      const share = Number(e.amount) / Math.max(e.split_among.length, 1);
      for (const m of e.split_among) net[m] = (net[m] ?? 0) - share;
    }
    const d = Object.entries(net).filter(([, v]) => v < -0.005).map(([k, v]) => ({ k, v: -v })).sort((a, b) => b.v - a.v);
    const c = Object.entries(net).filter(([, v]) => v > 0.005).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v);
    const out: { from: string; to: string; amount: number }[] = [];
    let i = 0, j = 0;
    while (i < d.length && j < c.length) {
      const p = Math.min(d[i].v, c[j].v);
      out.push({ from: d[i].k, to: c[j].k, amount: Math.round(p * 100) / 100 });
      d[i].v -= p; c[j].v -= p;
      if (d[i].v < 0.005) i++;
      if (c[j].v < 0.005) j++;
    }
    return out;
  }, [list.data]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const amt = Math.round(Number(amount) * 100) / 100;
    if (!(amt > 0)) return setErr("Enter an amount");
    if (!split.length) return setErr("Pick who shares it");
    const { error } = await supabase.from("expenses").insert({ household_id: house.id, created_by: profile.id, paid_by: paidBy, amount: amt, description: desc.trim(), split_among: split, recurring: recurring || null });
    if (error) return setErr(error.message);
    setAmount(""); setDesc(""); setRecurring(""); list.reload();
  };
  const settleAll = async () => {
    if (!confirm("Mark everything as settled? Do this after the payments above are made.")) return;
    await supabase.from("expenses").update({ settled: true }).eq("settled", false);
    list.reload();
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", alignItems: "start" }}>
      <div className="stack">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Who owes whom</h2>
          {transfers.length === 0 ? <p className="muted">All square.</p> : transfers.map((t, i) => (
            <div key={i} className="item"><div className="grow"><strong>{nm(t.from)}</strong> pays <strong>{nm(t.to)}</strong></div><strong>{usd(t.amount, 2)}</strong></div>
          ))}
          {transfers.length > 0 && <button className="btn sm" style={{ marginTop: 10 }} onClick={settleAll}>We settled up</button>}
        </div>
        <form className="card" onSubmit={add}>
          <h3 style={{ marginTop: 0 }}>Add a shared cost</h3>
          <div className="row">
            <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder="$0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <input className="input grow" placeholder="Costco run" value={desc} onChange={(e) => setDesc(e.target.value)} required maxLength={160} />
          </div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <small className="muted">Paid by</small>
            <select className="input" style={{ width: "auto" }} value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>{adults.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <select className="input" style={{ width: "auto" }} value={recurring} onChange={(e) => setRecurring(e.target.value)}><option value="">One time</option><option value="monthly">Monthly bill</option><option value="yearly">Yearly bill</option></select>
          </div>
          <div className="row wrap" style={{ gap: 6, margin: "8px 0" }}>
            <small className="muted">Split with</small>
            {adults.map((m) => (
              <label key={m.id} className="chip" style={{ cursor: "pointer" }}><input type="checkbox" checked={split.includes(m.id)} onChange={(e) => setSplit(e.target.checked ? [...split, m.id] : split.filter((x) => x !== m.id))} style={{ marginRight: 4 }} />{m.name}</label>
            ))}
          </div>
          <button className="btn primary sm">Add</button>
          <ErrorBox msg={err} />
        </form>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recent</h2>
        {list.loading ? <Loading /> : (list.data ?? []).length === 0 ? <p className="muted">No shared costs yet. Only adults see this tab.</p> : (list.data ?? []).map((e) => (
          <div key={e.id} className="item" style={{ opacity: e.settled ? 0.5 : 1 }}>
            <div className="grow"><div className="title">{e.description}{e.recurring && <span className="chip" style={{ marginLeft: 6 }}>{e.recurring}</span>}</div><div className="sub">{nm(e.paid_by)} paid · split {e.split_among.length} ways · {e.spent_on}{e.settled ? " · settled" : ""}</div></div>
            <strong>{usd(Number(e.amount), 2)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ people and invites
function People({ me, members, onChange }: { me: Member; members: Member[]; onChange: () => void }) {
  const [role, setRole] = useState<"adult" | "teen">("adult");
  const [guardian, setGuardian] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [kid, setKid] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const invite = async () => {
    setErr(null); setLink(null);
    const { data, error } = await supabase.rpc("create_household_invite", { p_role: role, p_guardian: guardian });
    if (error) return setErr(error.message);
    setLink(`${window.location.origin}/?invite=${data}`);
  };
  const share = async () => {
    if (!link) return;
    const text = `Join our family on Twofold: ${link}`;
    if (navigator.share) { try { await navigator.share({ title: "Join our family on Twofold", text, url: link }); return; } catch { /* fall back to copy */ } }
    await navigator.clipboard.writeText(text);
  };
  const addKid = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const { error } = await supabase.rpc("add_kid", { p_name: kid.trim() });
    if (error) return setErr(error.message);
    setKid(""); onChange();
  };
  const removeMember = async (m: Member) => {
    if (!confirm(`Remove ${m.name} from the household?`)) return;
    const { error } = m.role === "kid" ? await supabase.rpc("remove_kid", { p_member: m.id }) : await supabase.rpc("remove_household_member", { p_member: m.id });
    if (error) return setErr(error.message);
    onChange();
  };
  const leave = async () => {
    if (!confirm("Leave this household? Your shared lists become private again.")) return;
    const { error } = await supabase.rpc("leave_household");
    if (error) return setErr(error.message);
    onChange();
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", alignItems: "start" }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Household</h2>
        {members.map((m, i) => (
          <div key={m.id} className="item">
            <span className="dot" style={{ background: colorOf(m, i), marginTop: 6 }} />
            <div className="grow"><div className="title">{m.name}{m.id === me.id ? " (you)" : ""}</div><div className="sub">{m.role === "owner" ? "Owner" : m.role === "adult" ? "Adult" : m.role === "teen" ? "Teen, parent invited" : "Kid, no login"}</div></div>
            {((me.role === "owner" && m.id !== me.id) || (m.role === "kid" && isAdult(me))) && <button className="btn ghost sm danger" onClick={() => removeMember(m)}>Remove</button>}
          </div>
        ))}
        <button className="btn ghost sm danger" style={{ marginTop: 10 }} onClick={leave}>Leave household</button>
      </div>
      {isAdult(me) && (
        <div className="stack">
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Invite someone</h2>
            <div className="row" style={{ gap: 6, marginBottom: 10 }}>
              <button className={`btn sm ${role === "adult" ? "primary" : ""}`} onClick={() => { setRole("adult"); setLink(null); }}>Adult</button>
              <button className={`btn sm ${role === "teen" ? "primary" : ""}`} onClick={() => { setRole("teen"); setLink(null); }}>Teen (13 to 17)</button>
            </div>
            {role === "teen" && (
              <label className="row" style={{ marginBottom: 10, alignItems: "flex-start" }}>
                <input type="checkbox" checked={guardian} onChange={(e) => setGuardian(e.target.checked)} style={{ marginTop: 3 }} />
                <span className="ink2" style={{ fontSize: 14 }}>I am this teen's parent or legal guardian, they are 13 or older, and I agree to them using Twofold, including its AI assistant with teen safety filters. Teens cannot connect Gmail or see family money.</span>
              </label>
            )}
            <button className="btn primary" onClick={invite} disabled={role === "teen" && !guardian}>Create invite link</button>
            {link && (
              <div style={{ marginTop: 10 }}>
                <input className="input mono" readOnly value={link} onFocus={(e) => e.target.select()} />
                <div className="row" style={{ marginTop: 6 }}><button className="btn sm gold" onClick={share}>Share or copy</button><small className="muted">Single use, expires in 14 days. It also lets them skip the beta waitlist.</small></div>
              </div>
            )}
          </div>
          <form className="card" onSubmit={addKid}>
            <h3 style={{ marginTop: 0 }}>Add a younger kid</h3>
            <p className="muted" style={{ marginTop: 0 }}>Kids under 13 do not get a login. Add them so you can put them on the calendar, rides and chores.</p>
            <div className="row"><input className="input grow" placeholder="Name" value={kid} onChange={(e) => setKid(e.target.value)} required maxLength={60} /><button className="btn">Add</button></div>
          </form>
        </div>
      )}
      <ErrorBox msg={err} />
    </div>
  );
}
