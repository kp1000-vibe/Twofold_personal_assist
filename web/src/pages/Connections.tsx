import { useState } from "react";
import { ago, ErrorBox, fn, Loading, must, supabase, useLoad } from "../lib";

type Member = { id: string; name: string; role: string };
type Source = { id: string; kind: "ics" | "email"; provider: string; name: string; url: string | null; member_ids: string[]; last_synced_at: string | null; last_error: string | null; events_count: number };
type Provider = { label: string; kind: "ics" | "email"; how: string };

/** School and daycare plugins: calendar feeds and the family forwarding inbox. Everyone in the house sees the results. */
export default function Connections({ members, isAdult }: { members: Member[]; isAdult: boolean }) {
  const cfg = useLoad(() => fn<{ providers: Record<string, Provider>; inbox: string | null; inbox_ready: boolean }>("family-sources", { op: "providers" }));
  const sources = useLoad(async () => must(await supabase.from("family_sources").select("*").order("created_at")) as Source[]);
  const [provider, setProvider] = useState("school");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kids, setKids] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [inbox, setInbox] = useState<string | null>(null);

  const p = cfg.data?.providers ?? {};
  const feedProviders = Object.entries(p).filter(([, v]) => v.kind === "ics");
  const emailProviders = Object.entries(p).filter(([, v]) => v.kind === "email");
  const address = inbox ?? cfg.data?.inbox ?? null;
  const children = members.filter((m) => m.role === "kid" || m.role === "teen");

  const addFeed = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setOk(null);
    try {
      const r = await fn<{ sync: { events: number } }>("family-sources", { op: "add_feed", provider, name, url, member_ids: kids });
      setOk(`Connected. ${r.sync.events} events added to the family calendar.`);
      setUrl(""); setName(""); setKids([]); sources.reload();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const getInbox = async () => {
    setBusy(true); setErr(null);
    try { const r = await fn<{ address: string }>("family-sources", { op: "inbox" }); setInbox(r.address); sources.reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const sync = async (s: Source) => { setErr(null); try { await fn("family-sources", { op: "sync", id: s.id }); sources.reload(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const remove = async (s: Source) => {
    if (!confirm(`Disconnect ${s.name}? Its events come off the family calendar.`)) return;
    await supabase.from("family_sources").delete().eq("id", s.id);
    sources.reload();
  };
  const nm = (id: string) => members.find((m) => m.id === id)?.name;

  return (
    <div className="stack">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>School and daycare</h2>
        <p className="ink2" style={{ marginTop: 0 }}>Connect the school calendar, sports teams and daycare once. Everyone in the house sees the updates on the family calendar and in the family chat, and Twofold tells you when something changes.</p>
        {sources.loading ? <Loading /> : (sources.data ?? []).length === 0 ? <p className="muted">Nothing connected yet.</p> : (sources.data ?? []).map((s) => (
          <div key={s.id} className="item">
            <span style={{ fontSize: 20 }}>{s.kind === "ics" ? "📅" : "📨"}</span>
            <div className="grow">
              <div className="title">{s.name}{s.member_ids.length ? <span className="muted"> · {s.member_ids.map(nm).filter(Boolean).join(", ")}</span> : null}</div>
              <div className="sub">
                {s.last_error ? <span style={{ color: "var(--bad)" }}>Problem: {s.last_error}</span>
                  : s.kind === "ics" ? `${s.events_count} upcoming events${s.last_synced_at ? ` · checked ${ago(s.last_synced_at)}` : ""}`
                  : `${s.events_count} emails read${s.last_synced_at ? ` · last ${ago(s.last_synced_at)}` : ""}`}
              </div>
            </div>
            {s.kind === "ics" && isAdult && <button className="btn ghost sm" onClick={() => sync(s)}>Check now</button>}
            {isAdult && <button className="btn ghost sm danger" onClick={() => remove(s)}>Remove</button>}
          </div>
        ))}
      </div>

      {isAdult && (
        <form className="card" onSubmit={addFeed}>
          <h3 style={{ marginTop: 0 }}>📅 Add a calendar</h3>
          <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
            {feedProviders.map(([k, v]) => <button type="button" key={k} className={`btn sm ${provider === k ? "primary" : "ghost"}`} onClick={() => setProvider(k)}>{v.label}</button>)}
          </div>
          {p[provider] && <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>{p[provider].how}</p>}
          <label className="field"><span>Calendar link</span><input className="input mono" placeholder="https://… or webcal://…" value={url} onChange={(e) => setUrl(e.target.value)} required /></label>
          <label className="field"><span>Name it</span><input className="input" placeholder="Lincoln Elementary, U10 Soccer" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
          {children.length > 0 && (
            <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
              <small className="muted">For:</small>
              {children.map((m) => (
                <label key={m.id} className="chip" style={{ cursor: "pointer" }}><input type="checkbox" checked={kids.includes(m.id)} onChange={(e) => setKids(e.target.checked ? [...kids, m.id] : kids.filter((x) => x !== m.id))} style={{ marginRight: 4 }} />{m.name}</label>
              ))}
            </div>
          )}
          <button className="btn primary" disabled={busy || !url.trim()}>{busy ? "Connecting" : "Connect"}</button>
        </form>
      )}

      {isAdult && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>📨 Family inbox for daycare and school apps</h3>
          <p className="ink2" style={{ marginTop: 0 }}>{emailProviders.map(([, v]) => v.label).join(", ")} do not let other apps connect directly, but they all send email. Forward those emails to your family inbox and Twofold turns them into events, forms and reminders for everyone.</p>
          {address ? (
            <>
              <div className="row"><input className="input mono grow" readOnly value={address} onFocus={(e) => e.target.select()} /><button className="btn sm gold" type="button" onClick={() => navigator.clipboard.writeText(address)}>Copy</button></div>
              <ol className="ink2" style={{ fontSize: 14, paddingLeft: 18 }}>
                <li>In Gmail: Settings, Forwarding, Add a forwarding address, paste this. Gmail sends a code; it will show up in your family chat.</li>
                <li>Make a filter for the school or app sender (for example from:brightwheel.com) and choose Forward to this address.</li>
                <li>Or just forward any school email by hand. That works too.</li>
              </ol>
            </>
          ) : cfg.data?.inbox_ready ? (
            <button className="btn primary" disabled={busy} onClick={getInbox}>Create our family inbox</button>
          ) : <div className="notice">The family inbox is being switched on. Calendar links work today.</div>}
        </div>
      )}
      {ok && <div className="success">{ok}</div>}
      <ErrorBox msg={err ?? cfg.error} />
    </div>
  );
}
