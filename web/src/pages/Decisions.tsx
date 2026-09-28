import { useState } from "react";
import { ago, Empty, ErrorBox, fn, Loading, must, supabase, useLoad } from "../lib";

type Decision = {
  id: string; content: string; reason: string | null; expectation: string | null; created_at: string;
  check_after: string | null; replay_asked_at: string | null; replay_note: string | null;
  outcome: string | null; verdict: "worked" | "mixed" | "did_not" | null; checked_at: string | null;
};

const VERDICT: Record<string, { label: string; cls: string }> = {
  worked: { label: "Worked", cls: "good" },
  mixed: { label: "Mixed", cls: "warn" },
  did_not: { label: "Did not work", cls: "bad" },
};

export default function Decisions({ params }: { params: URLSearchParams }) {
  const list = useLoad(async () => must(await supabase.from("memories").select("*").eq("kind", "decision").order("created_at", { ascending: false })) as Decision[]);
  const all = list.data ?? [];
  const focus = params.get("id");
  const reviewed = all.filter((d) => d.verdict);
  const worked = reviewed.filter((d) => d.verdict === "worked").length;
  const asking = all.filter((d) => !d.verdict && d.replay_asked_at);
  const waiting = all.filter((d) => !d.verdict && !d.replay_asked_at);
  const done = reviewed;

  return (
    <div>
      <div className="page-head">
        <div><h1>Decisions</h1><p>Every call you make gets a check back date. Twofold asks how it went, so you learn from your own track record.</p></div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="l">Decisions saved</div><div className="v">{all.length}</div></div>
        <div className="card stat"><div className="l">Reviewed</div><div className="v">{reviewed.length}</div></div>
        <div className="card stat"><div className="l">Worked out</div><div className="v">{reviewed.length ? `${Math.round((worked / reviewed.length) * 100)}%` : "·"}</div></div>
        <div className="card stat"><div className="l">Next check</div><div className="v" style={{ fontSize: 18 }}>{nextCheck(waiting)}</div></div>
      </div>

      {list.loading ? <Loading /> : all.length === 0 ? (
        <div className="card"><Empty title="No decisions yet">Tell Twofold about a choice you made, like "I decided to switch to the cheaper phone plan to save money". It will check back later.</Empty></div>
      ) : (
        <>
          {asking.length > 0 && <><h2>How did these go?</h2>{asking.map((d) => <Card key={d.id} d={d} open onDone={list.reload} highlight={d.id === focus} />)}</>}
          {waiting.length > 0 && <><h2 style={{ marginTop: 24 }}>Waiting to check back</h2>{waiting.map((d) => <Card key={d.id} d={d} onDone={list.reload} highlight={d.id === focus} />)}</>}
          {done.length > 0 && <><h2 style={{ marginTop: 24 }}>Your track record</h2>{done.map((d) => <Card key={d.id} d={d} onDone={list.reload} highlight={d.id === focus} />)}</>}
        </>
      )}
    </div>
  );
}

function nextCheck(ds: Decision[]) {
  const next = ds.map((d) => d.check_after).filter(Boolean).sort()[0];
  if (!next) return "·";
  const days = Math.ceil((new Date(next).getTime() - Date.now()) / 864e5);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

function Card({ d, open, onDone, highlight }: { d: Decision; open?: boolean; onDone: () => void; highlight?: boolean }) {
  const [outcome, setOutcome] = useState(d.outcome ?? "");
  const [editing, setEditing] = useState(!!open);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const record = async (verdict: "worked" | "mixed" | "did_not" | "later") => {
    setBusy(true); setErr(null);
    const patch = verdict === "later"
      ? { check_after: new Date(Date.now() + 60 * 864e5).toISOString(), replay_asked_at: null, outcome: outcome.trim() || null }
      : { verdict, outcome: outcome.trim() || null, checked_at: new Date().toISOString() };
    const { error } = await supabase.from("memories").update(patch).eq("id", d.id);
    setBusy(false);
    if (error) return setErr(error.message);
    onDone();
  };
  const askNow = async () => {
    setBusy(true); setErr(null);
    try { await fn("reflect", { op: "replay", id: d.id }); onDone(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const setCheck = async (days: number) => {
    await supabase.from("memories").update({ check_after: new Date(Date.now() + days * 864e5).toISOString() }).eq("id", d.id);
    onDone();
  };
  const v = d.verdict ? VERDICT[d.verdict] : null;

  return (
    <div className="card" style={highlight ? { outline: "2px solid var(--gold)" } : undefined}>
      <div className="row spread" style={{ marginBottom: 6 }}>
        <strong>{d.content}</strong>
        {v ? <span className={`chip ${v.cls}`}>{v.label}</span> : <small>{ago(d.created_at)}</small>}
      </div>
      {d.reason && <div className="ink2">Because {d.reason}</div>}
      {d.expectation && <div className="ink2" style={{ marginTop: 4 }}>Expected: {d.expectation}</div>}
      {d.replay_note && !d.verdict && <div className="notice" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{d.replay_note}</div>}
      {d.verdict && d.outcome && <div style={{ marginTop: 8 }}>What happened: {d.outcome}</div>}

      {!d.verdict && editing && (
        <div style={{ marginTop: 12 }}>
          <label className="field"><span>What actually happened? (optional)</span>
            <textarea className="input" rows={2} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Saved about $140 a month, but charging is a hassle" />
          </label>
          <div className="row wrap">
            <button className="btn primary sm" disabled={busy} onClick={() => record("worked")}>Worked</button>
            <button className="btn sm" disabled={busy} onClick={() => record("mixed")}>Mixed</button>
            <button className="btn sm" disabled={busy} onClick={() => record("did_not")}>Did not work</button>
            <button className="btn ghost sm" disabled={busy} onClick={() => record("later")}>Too early, ask in 2 months</button>
          </div>
        </div>
      )}
      {!d.verdict && !editing && (
        <div className="row wrap spread" style={{ marginTop: 10 }}>
          <small className="muted">Check back {d.check_after ? new Date(d.check_after).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "later"}</small>
          <div className="row wrap" style={{ gap: 6 }}>
            <select className="input" style={{ width: "auto", padding: "4px 8px" }} value="" onChange={(e) => e.target.value && setCheck(Number(e.target.value))}>
              <option value="">Change date</option>
              <option value="30">In 1 month</option>
              <option value="90">In 3 months</option>
              <option value="180">In 6 months</option>
              <option value="365">In 1 year</option>
            </select>
            <button className="btn ghost sm" disabled={busy} onClick={askNow}>{busy ? "Looking back" : "Replay now"}</button>
            <button className="btn ghost sm" onClick={() => setEditing(true)}>I know already</button>
          </div>
        </div>
      )}
      <ErrorBox msg={err} />
    </div>
  );
}
