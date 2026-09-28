import { useState } from "react";
import { ago, Empty, fn, Loading, must, Profile, supabase, useLoad, when } from "../lib";

type Action = { id: string; kind: string; title: string; summary: string | null; payload: any; status: string; source: string; created_at: string; result: any; why: string | null; execute_after: string | null };

export default function Approvals({ profile }: { profile: Profile }) {
  const pending = useLoad(async () => must(await supabase.from("actions").select("*").in("status", ["pending", "scheduled"]).order("created_at", { ascending: false })) as Action[]);
  const past = useLoad(async () => must(await supabase.from("actions").select("*").not("status", "in", "(pending,scheduled)").order("decided_at", { ascending: false }).limit(15)) as Action[]);
  const reload = () => { pending.reload(); past.reload(); };

  return (
    <div>
      <div className="page-head">
        <div><h1>Approvals</h1><p>Nothing here goes out until you say so.</p></div>
      </div>
      {pending.loading ? <Loading /> : (pending.data ?? []).length === 0 ? (
        <div className="card"><Empty title="Nothing waiting">Drafts and errands will show up here.</Empty></div>
      ) : (pending.data ?? []).map((a) => <ActionCard key={a.id} a={a} tz={profile.timezone} onDone={reload} />)}

      {(past.data ?? []).length > 0 && (
        <>
          <h2 style={{ marginTop: 30 }}>Recently handled</h2>
          <div className="card" style={{ padding: "4px 14px" }}>
            {(past.data ?? []).map((a) => (
              <div key={a.id} className="item">
                <span className={`chip ${a.status === "done" ? "good" : a.status === "failed" ? "bad" : ""}`}>{a.status === "done" ? (a.kind === "concierge" ? "done" : "sent") : a.status}</span>
                <div className="grow"><div className="title">{a.title}</div><div className="sub">{a.summary}{a.status === "failed" && a.result?.error ? ` · ${a.result.error}` : ""}</div></div>
                <small>{ago(a.created_at)}</small>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ActionCard({ a, tz, onDone }: { a: Action; tz: string; onDone: () => void }) {
  const p = a.payload ?? {};
  const [to, setTo] = useState(p.to ?? "");
  const [cc, setCc] = useState(p.cc ?? "");
  const [subject, setSubject] = useState(p.subject ?? "");
  const [body, setBody] = useState(p.body ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setErr(null);
    try {
      const edits = a.kind === "send_email" || a.kind === "cancel_subscription" ? { to, cc, subject, body } : undefined;
      await fn("execute-action", { action_id: a.id, decision, edits });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isEmail = a.kind === "send_email" || a.kind === "cancel_subscription";
  const label = { send_email: "Email", cancel_subscription: "Cancel request", create_event: "Calendar", concierge: "Errand" }[a.kind] ?? a.kind;

  return (
    <div className="card">
      <div className="row spread" style={{ marginBottom: 10 }}>
        <div className="row"><span className="chip gold">{label}</span><strong>{a.title}</strong></div>
        <small>{a.source === "email" ? "from your inbox · " : ""}{ago(a.created_at)}</small>
      </div>

      {a.status === "scheduled" && (
        <div className="notice" style={{ marginBottom: 10 }}>
          Goes ahead automatically at {a.execute_after ? new Date(a.execute_after).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "soon"}. {a.why}
        </div>
      )}
      {a.status === "pending" && a.why && <div className="sub" style={{ marginBottom: 8 }}>{a.why}</div>}
      {isEmail && (
        <>
          {p.original_snippet && <div className="notice" style={{ marginBottom: 10 }}><small>They wrote:</small> {p.original_snippet}</div>}
          <div className="row wrap">
            <label className="field grow"><span>To</span><input className="input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <label className="field grow"><span>Cc</span><input className="input" value={cc} onChange={(e) => setCc(e.target.value)} /></label>
          </div>
          <label className="field"><span>Subject</span><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="field"><span>Message</span><textarea className="input" rows={Math.min(14, Math.max(5, body.split("\n").length + 1))} value={body} onChange={(e) => setBody(e.target.value)} /></label>
          {/\[[^\]]{2,}\]/.test(body) && <div className="notice" style={{ marginBottom: 10 }}>Fill in the parts in [brackets] before sending.</div>}
        </>
      )}

      {a.kind === "create_event" && (
        <div className="stack">
          <div><strong>{p.summary}</strong></div>
          <div className="ink2">{when(p.start, p.timezone ?? tz)} to {when(p.end, p.timezone ?? tz)}</div>
          {p.location && <div className="ink2">📍 {p.location}</div>}
          {p.attendees?.length > 0 && <div className="ink2">Invites: {p.attendees.join(", ")}</div>}
          {p.description && <div className="ink2">{p.description}</div>}
        </div>
      )}

      {a.kind === "concierge" && (
        <div className="stack">
          {a.summary && <p className="ink2">{a.summary}</p>}
          {p.steps?.length > 0 && <ol style={{ margin: 0, paddingLeft: 20 }}>{p.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>}
          {p.links?.length > 0 && (
            <div className="row wrap">{p.links.map((l: any) => <a key={l.url} className="btn sm" href={l.url} target="_blank" rel="noopener">{l.label} ↗</a>)}</div>
          )}
          {p.details && (
            <div>
              <div className="row spread"><small>Details to paste</small><button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(p.details)}>Copy</button></div>
              <pre className="mono" style={{ whiteSpace: "pre-wrap", background: "var(--surface-2)", padding: 10, borderRadius: 10, margin: 0 }}>{p.details}</pre>
            </div>
          )}
        </div>
      )}

      {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
      <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
        <button className="btn ghost danger" onClick={() => decide("reject")} disabled={busy}>{a.status === "scheduled" ? "Cancel" : "Discard"}</button>
        <button className="btn primary" onClick={() => decide("approve")} disabled={busy}>
          {busy ? "Working" : a.status === "scheduled" ? "Do it now" : isEmail ? "Approve and send" : a.kind === "create_event" ? "Add to calendar" : "Mark done"}
        </button>
      </div>
    </div>
  );
}
