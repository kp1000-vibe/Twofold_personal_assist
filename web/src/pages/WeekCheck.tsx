import { useState } from "react";
import { ErrorBox, fn, Markdown, must, supabase, useLoad } from "../lib";

type Pm = { id?: string; week_start: string; headline: string; content: string; risks: any[]; stats: Record<string, any>; created_at?: string };

/** The Sunday pre mortem card on Today: where this week could break, and the fixes. */
export default function WeekCheck() {
  const latest = useLoad(async () => must(await supabase.from("premortems").select("*").order("week_start", { ascending: false }).limit(1).maybeSingle()) as Pm | null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pm = latest.data;
  const stale = pm && Date.now() - new Date(`${pm.week_start}T00:00:00`).getTime() > 7 * 864e5;

  const run = async () => {
    setBusy(true); setErr(null);
    try { await fn("reflect", { op: "premortem" }); await latest.reload(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="row spread wrap" style={{ marginBottom: 8 }}>
        <div className="row"><span style={{ fontSize: 20 }}>🔮</span><h2 style={{ margin: 0 }}>Week check</h2></div>
        <button className="btn sm" onClick={run} disabled={busy}>{busy ? "Walking through your week" : pm && !stale ? "Run again" : "Check my week now"}</button>
      </div>
      {!pm || stale ? (
        <p className="ink2" style={{ margin: 0 }}>Every Sunday at 6 pm Twofold walks through your coming week before it happens: meetings, promises, deadlines, birthdays and bills. It tells you the few spots that will break and drafts fixes.</p>
      ) : (
        <>
          <Markdown text={pm.content} />
          {pm.stats && (
            <div className="meta-line" style={{ marginTop: 10 }}>
              <span className="bolt">⚡</span>
              <span>Week of {pm.week_start}</span><span>·</span>
              <span>{pm.stats.meeting_hours ?? 0}h meetings</span><span>·</span>
              <span>{pm.stats.free_hours ?? 0}h open</span><span>·</span>
              <span>Jev checked {pm.stats.checked_by_jev ?? pm.stats.checks ?? 0} things</span>
            </div>
          )}
          {pm.risks?.some((r) => r.block) && <div style={{ marginTop: 10 }}><a className="btn sm gold" href="#/approvals">Review focus blocks</a></div>}
        </>
      )}
      <ErrorBox msg={err} />
    </div>
  );
}
