import { useState } from "react";
import WeekCheck from "./WeekCheck";
import { ago, Empty, ErrorBox, fn, Loading, Markdown, must, Profile, supabase, useLoad } from "../lib";

export default function Today({ profile }: { profile: Profile }) {
  const brief = useLoad(async () => must(await supabase.from("briefs").select("*").order("brief_date", { ascending: false }).limit(1).maybeSingle()));
  const notes = useLoad(async () => must(await supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(30)));
  const counts = useLoad(async () => {
    const [a, t] = await Promise.all([
      supabase.from("actions").select("id", { count: "exact", head: true }).in("status", ["pending", "scheduled"]),
      supabase.from("tasks").select("id", { count: "exact", head: true }).eq("status", "open"),
    ]);
    return { approvals: a.count ?? 0, tasks: t.count ?? 0 };
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const regenerate = async () => {
    setBusy(true);
    setErr(null);
    try {
      await fn("daily-brief");
      await brief.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const markAll = async () => {
    await supabase.from("notifications").update({ read: true }).eq("read", false);
    notes.reload();
  };

  const b = brief.data as any;
  const all = (notes.data ?? []) as any[];
  const list = all.filter((n) => !n.quiet);
  const quietList = all.filter((n) => n.quiet);
  const unread = list.filter((n) => !n.read).length;

  return (
    <div>
      <div className="page-head">
        <div><h1>Today</h1><p>Your brief lands at {fmtHour(profile.brief_hour)} each morning.</p></div>
        <button className="btn" onClick={regenerate} disabled={busy}>{busy ? "Writing" : b ? "Refresh brief" : "Make my brief now"}</button>
      </div>
      <ErrorBox msg={err} />

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <a className="card stat" href="#/approvals" style={{ textDecoration: "none" }}><div className="l">Waiting for your OK</div><div className="v">{counts.data?.approvals ?? "·"}</div></a>
        <a className="card stat" href="#/tasks" style={{ textDecoration: "none" }}><div className="l">Open tasks</div><div className="v">{counts.data?.tasks ?? "·"}</div></a>
      </div>

      <WeekCheck />

      <div className="card">
        {brief.loading ? <Loading /> : b ? (
          <>
            <div className="row spread" style={{ marginBottom: 8 }}><span className="chip">{b.brief_date}</span><small>{ago(b.created_at)}</small></div>
            <Markdown text={b.content} />
          </>
        ) : <Empty title="No brief yet">Tap "Make my brief now" to get one.</Empty>}
      </div>

      <div className="row spread" style={{ margin: "26px 0 8px" }}>
        <h2 style={{ margin: 0 }}>Updates</h2>
        {unread > 0 && <button className="btn ghost sm" onClick={markAll}>Mark all read</button>}
      </div>
      <div className="card" style={{ padding: "4px 14px" }}>
        {list.length === 0 ? <Empty title="All quiet" /> : list.map((n) => (
          <a key={n.id} className="item" href={n.link ?? "#/today"} style={{ textDecoration: "none", opacity: n.read ? 0.6 : 1 }}>
            <span className="dot" style={{ background: n.read ? "var(--line)" : "var(--gold)", marginTop: 8 }} />
            <div className="grow"><div className="title">{n.title}</div>{n.body && <div className="sub">{n.body}</div>}{n.why && <div className="sub" style={{ color: "var(--ink-2)" }}>Why now: {n.why}</div>}</div>
            <small>{ago(n.created_at)}</small>
          </a>
        ))}
      </div>
      {quietList.length > 0 && (
        <details style={{ marginTop: 16 }}>
          <summary className="muted">Quietly noted ({quietList.length}), not worth a buzz</summary>
          <div className="card" style={{ padding: "4px 14px", marginTop: 8 }}>
            {quietList.map((n) => (
              <a key={n.id} className="item" href={n.link ?? "#/today"} style={{ textDecoration: "none" }}>
                <div className="grow"><div className="title">{n.title}</div>{n.why && <div className="sub">Why: {n.why}</div>}</div>
                <small>{ago(n.created_at)}</small>
              </a>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function fmtHour(h: number) {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d.toLocaleTimeString("en-US", { hour: "numeric" });
}
