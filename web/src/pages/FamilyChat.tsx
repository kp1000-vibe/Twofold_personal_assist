import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorBox, fn, Markdown, supabase } from "../lib";

export type FMember = { id: string; household_id: string; user_id: string | null; role: string; name: string; color: string | null };
type Msg = { id: string; author_user: string | null; author_name: string; content: string; meta: any; created_at: string };
export type Proposal = { id: string; kind: string; title: string; body: string | null; payload: any; status: string; decided_by: string | null; created_at: string };

const COLORS = ["#E8A33D", "#5B8DEF", "#3FB68B", "#E36B6B", "#A77BDB", "#E88BB8", "#4FB3BF", "#8C9A5B"];
const KIND_ICON: Record<string, string> = { driver: "🚗", chores: "🧹", groceries: "🛒", school: "🏫" };
const isAdult = (m?: FMember | null) => !!m && (m.role === "owner" || m.role === "adult");

function initials(n: string) { return n.split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase(); }
function dayLabel(d: Date) {
  const t = new Date(); const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === t.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

/** One proposal card with Accept and Decline. Used in the chat and on Home. */
export function ProposalCard({ p, me, members, onDone }: { p: Proposal; me: FMember; members: FMember[]; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [driver, setDriver] = useState<string>(p.payload?.driver_member_id ?? "");
  const [items, setItems] = useState<string[]>(p.payload?.items ?? []);
  const decide = async (decision: "accept" | "decline") => {
    setBusy(true); setErr(null);
    try {
      await fn("family-act", { proposal_id: p.id, decision, edits: p.kind === "driver" ? { driver_member_id: driver } : p.kind === "groceries" ? { items } : {} });
      onDone?.();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const who = members.find((m) => m.user_id === p.decided_by)?.name;
  return (
    <div className="card" style={{ margin: "6px 0", borderLeft: "4px solid var(--gold)", padding: 12 }}>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <span style={{ fontSize: 20 }}>{KIND_ICON[p.kind] ?? "✨"}</span>
        <div className="grow">
          <strong>{p.title}</strong>
          {p.body && <div className="ink2" style={{ whiteSpace: "pre-wrap", fontSize: 14, marginTop: 4 }}>{p.body}</div>}
        </div>
      </div>
      {p.status === "pending" ? (
        isAdult(me) ? (
          <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
            {p.kind === "driver" && (
              <select className="input" style={{ width: "auto" }} value={driver} onChange={(e) => setDriver(e.target.value)}>
                <option value="">Who drives?</option>
                {members.filter(isAdult).map((m) => <option key={m.id} value={m.id}>{m.id === me.id ? "Me" : m.name}</option>)}
              </select>
            )}
            {p.kind === "groceries" && (
              <div className="row wrap" style={{ gap: 4, flexBasis: "100%" }}>
                {(p.payload?.items ?? []).map((t: string) => (
                  <label key={t} className="chip" style={{ cursor: "pointer" }}>
                    <input type="checkbox" checked={items.includes(t)} onChange={(e) => setItems(e.target.checked ? [...items, t] : items.filter((x) => x !== t))} style={{ marginRight: 4 }} />{t}
                  </label>
                ))}
              </div>
            )}
            <button className="btn primary sm" disabled={busy || (p.kind === "driver" && !driver)} onClick={() => decide("accept")}>{busy ? "Working" : p.kind === "groceries" ? "Add to list" : "Accept"}</button>
            <button className="btn ghost sm" disabled={busy} onClick={() => decide("decline")}>Skip</button>
          </div>
        ) : <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>Waiting for a parent to approve</div>
      ) : (
        <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>{p.status === "accepted" ? `✅ Accepted${who ? ` by ${who}` : ""}` : p.status === "declined" ? `Skipped${who ? ` by ${who}` : ""}` : "Expired"}</div>
      )}
      <ErrorBox msg={err} />
    </div>
  );
}

function Photo({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { supabase.storage.from("uploads").createSignedUrl(path, 3600).then(({ data }) => setUrl(data?.signedUrl ?? null)); }, [path]);
  return url ? <a href={url} target="_blank" rel="noopener"><img src={url} alt="" style={{ maxWidth: 240, maxHeight: 240, borderRadius: 10, display: "block", marginBottom: 4 }} /></a> : <div className="muted" style={{ fontSize: 12 }}>Loading photo</div>;
}

export default function FamilyChat({ me, houseId, members }: { me: FMember; houseId: string; members: FMember[] }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [props, setProps] = useState<Record<string, Proposal>>({});
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadProps = async () => {
    const { data } = await supabase.from("family_proposals").select("*").order("created_at", { ascending: false }).limit(60);
    setProps(Object.fromEntries((data ?? []).map((p: any) => [p.id, p as Proposal])));
  };
  useEffect(() => {
    supabase.from("family_messages").select("*").order("created_at", { ascending: false }).limit(120).then(({ data }) => setMsgs(((data ?? []) as Msg[]).reverse()));
    loadProps();
    const ch = supabase.channel(`family-chat-${houseId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "family_messages", filter: `household_id=eq.${houseId}` }, (p: any) => setMsgs((cur) => (cur.some((x) => x.id === p.new.id) ? cur : [...cur, p.new as Msg])))
      .on("postgres_changes", { event: "*", schema: "public", table: "family_proposals", filter: `household_id=eq.${houseId}` }, (p: any) => setProps((cur) => ({ ...cur, [p.new.id]: p.new as Proposal })))
      .subscribe();
    const onResume = () => loadProps();
    window.addEventListener("twofold:resume", onResume);
    return () => { supabase.removeChannel(ch); window.removeEventListener("twofold:resume", onResume); };
  }, [houseId]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [msgs.length, busy]);

  const colorOf = (uid: string | null) => { const i = members.findIndex((m) => m.user_id === uid); return i >= 0 ? members[i].color ?? COLORS[i % COLORS.length] : "#1f2a44"; };

  const send = async (ask: boolean) => {
    const t = text.trim();
    if ((!t && !files.length) || busy) return;
    setBusy(true); setErr(null);
    const sending = files;
    setText(""); setFiles([]);
    try {
      const attachments = [];
      for (const f of sending) {
        const path = `family/${houseId}/${crypto.randomUUID()}-${f.name.replace(/[^\w.]+/g, "_").slice(-60)}`;
        const { error } = await supabase.storage.from("uploads").upload(path, f, { contentType: f.type });
        if (error) throw new Error(`Upload failed: ${error.message}`);
        attachments.push({ path, name: f.name, mime: f.type });
      }
      await fn("family-chat", { message: t, ask, attachments });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setText(t); } finally { setBusy(false); }
  };

  // group consecutive messages from the same author, with a date line when the day changes
  const rows = useMemo(() => {
    const out: { type: "day" | "msg"; label?: string; m?: Msg; first?: boolean }[] = [];
    let lastDay = "", lastAuthor: string | null | undefined;
    for (const m of msgs) {
      const d = new Date(m.created_at);
      if (d.toDateString() !== lastDay) { out.push({ type: "day", label: dayLabel(d) }); lastDay = d.toDateString(); lastAuthor = undefined; }
      out.push({ type: "msg", m, first: m.author_user !== lastAuthor || !!m.meta?.proposal_id });
      lastAuthor = m.author_user;
    }
    return out;
  }, [msgs]);

  const ideas = ["@Twofold add milk, eggs and bread", "Who can pick up Ria at 3:30 Friday?", "@Twofold make a fair chore plan for this week", "Split the Costco run, $142, I paid"];

  return (
    <div className="chat" style={{ height: "calc(100vh - 230px)", minHeight: 440 }}>
      <div className="chat-log" ref={logRef} style={{ background: "var(--surface-2)", borderRadius: 14, padding: "10px 10px 4px" }}>
        {msgs.length === 0 && (
          <div className="empty" style={{ paddingTop: 30 }}>
            <div className="big">Your family group chat, with Twofold in it</div>
            <p className="muted">Everyone in the house can chat here. Mention @Twofold or tap Ask to get help. Send a photo of a school flyer and it adds the dates. Twofold also posts its own suggestions here for a parent to approve.</p>
            <div className="suggest">{ideas.map((s) => <button key={s} onClick={() => setText(s)}>{s}</button>)}</div>
          </div>
        )}
        {rows.map((r, i) => r.type === "day" ? (
          <div key={`d${i}`} style={{ textAlign: "center", margin: "10px 0" }}><span className="chip" style={{ fontSize: 11 }}>{r.label}</span></div>
        ) : (() => {
          const m = r.m!;
          const mine = m.author_user === me.user_id;
          const bot = !m.author_user;
          const prop = m.meta?.proposal_id ? props[m.meta.proposal_id] : null;
          if (prop) return <div key={m.id} style={{ maxWidth: 520 }}><div style={{ fontSize: 12, fontWeight: 600, color: "var(--gold)", margin: "8px 0 2px 4px" }}>Twofold suggests</div><ProposalCard p={prop} me={me} members={members} onDone={loadProps} /></div>;
          return (
            <div key={m.id} className="row" style={{ justifyContent: mine ? "flex-end" : "flex-start", alignItems: "flex-end", gap: 6, marginTop: r.first ? 8 : 2 }}>
              {!mine && (r.first ? (
                <span style={{ width: 28, height: 28, borderRadius: 14, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", background: bot ? "#1f2a44" : colorOf(m.author_user) }}>{bot ? "✦" : initials(m.author_name)}</span>
              ) : <span style={{ width: 28, flex: "none" }} />)}
              <div style={{
                maxWidth: "78%", padding: "7px 11px", borderRadius: 14, fontSize: 15, lineHeight: 1.4,
                background: mine ? "#1f2a44" : bot ? "#fff7e6" : "var(--surface)", color: mine ? "#fff" : "var(--ink)",
                borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4, boxShadow: "0 1px 1px rgba(0,0,0,.06)",
              }}>
                {!mine && r.first && <div style={{ fontSize: 12, fontWeight: 600, color: bot ? "var(--gold)" : colorOf(m.author_user), marginBottom: 2 }}>{bot ? "Twofold (AI)" : m.author_name}</div>}
                {(m.meta?.attachments ?? []).map((a: any) => <Photo key={a.path} path={a.path} />)}
                {bot ? <Markdown text={m.content} /> : (m.content !== "📷 Photo" || !m.meta?.attachments?.length) && <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>}
                <div style={{ fontSize: 10, opacity: 0.6, textAlign: "right", marginTop: 2 }}>{new Date(m.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</div>
              </div>
            </div>
          );
        })())}
        {busy && <div className="row" style={{ gap: 6, marginTop: 8 }}><span style={{ width: 28 }} /><span className="thinking" style={{ background: "#fff7e6", padding: "6px 10px", borderRadius: 14 }}><i /><i /> Twofold is on it</span></div>}
      </div>
      <ErrorBox msg={err} />
      {files.length > 0 && (
        <div className="row wrap" style={{ gap: 6, margin: "6px 0" }}>
          {files.map((f, i) => <span key={i} className="chip">📷 {f.name} <button type="button" className="btn ghost sm" style={{ padding: "0 4px" }} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}
        </div>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(false); }}>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" hidden multiple onChange={(e) => { if (e.target.files) setFiles([...files, ...Array.from(e.target.files).filter((f) => f.size <= 20 * 1024 * 1024)].slice(0, 4)); e.target.value = ""; }} />
        <button type="button" className="btn ghost" title="Send a photo or PDF" onClick={() => fileRef.current?.click()}>📷</button>
        <textarea rows={1} value={text} placeholder="Message the family, or @Twofold" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(false); } }} />
        <button type="button" className="btn" disabled={busy || (!text.trim() && !files.length)} onClick={() => send(true)} title="Ask Twofold to help with this">✦ Ask</button>
        <button className="btn primary" disabled={busy || (!text.trim() && !files.length)}>Send</button>
      </form>
    </div>
  );
}
