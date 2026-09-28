import { Empty, go, Loading, must, Profile, supabase, useLoad, when } from "../lib";

type Goal = { id: string; title: string; why: string | null; target_date: string | null; status: string; notes: string | null; created_at: string };

export default function Goals({ profile }: { profile: Profile }) {
  const goals = useLoad(async () => must(await supabase.from("goals").select("*").neq("status", "dropped").order("created_at", { ascending: false })) as Goal[]);
  const steps = useLoad(async () => must(await supabase.from("tasks").select("id, goal_id, title, status, due_at").not("goal_id", "is", null).order("due_at", { ascending: true, nullsFirst: false })) as any[]);

  const toggle = async (t: any) => {
    await supabase.from("tasks").update({ status: t.status === "done" ? "open" : "done", completed_at: t.status === "done" ? null : new Date().toISOString() }).eq("id", t.id);
    steps.reload();
  };
  const setStatus = async (g: Goal, status: string) => { await supabase.from("goals").update({ status }).eq("id", g.id); goals.reload(); };

  return (
    <div>
      <div className="page-head">
        <div><h1>Goals</h1><p>Big things broken into steps. Twofold checks in when a goal stalls.</p></div>
        <button className="btn primary" onClick={() => go(`chat?q=${encodeURIComponent("I want to set a goal: ")}`)}>New goal</button>
      </div>
      {goals.loading ? <Loading /> : (goals.data ?? []).length === 0 ? (
        <div className="card"><Empty title="No goals yet">Try "I want to buy a house in the next 2 years" in chat.</Empty></div>
      ) : (goals.data ?? []).map((g) => {
        const mine = (steps.data ?? []).filter((t) => t.goal_id === g.id);
        const done = mine.filter((t) => t.status === "done").length;
        const pct = mine.length ? Math.round((done / mine.length) * 100) : 0;
        return (
          <div key={g.id} className="card">
            <div className="row spread wrap">
              <div><h3 style={{ margin: 0 }}>{g.title}</h3>{g.why && <div className="sub">Why: {g.why}</div>}</div>
              <div className="row">
                {g.target_date && <span className="chip">by {g.target_date}</span>}
                <span className={`chip ${g.status === "done" ? "good" : g.status === "paused" ? "" : "gold"}`}>{g.status}</span>
              </div>
            </div>
            <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 99, margin: "12px 0" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "var(--good)", borderRadius: 99 }} />
            </div>
            <small>{done} of {mine.length} steps done</small>
            <div style={{ marginTop: 6 }}>
              {mine.map((t) => (
                <div key={t.id} className="item" style={{ padding: "8px 2px" }}>
                  <button className="check" onClick={() => toggle(t)} aria-label="Toggle step" style={t.status === "done" ? { background: "var(--good)", borderColor: "var(--good)" } : undefined} />
                  <div className="grow" style={{ textDecoration: t.status === "done" ? "line-through" : undefined, color: t.status === "done" ? "var(--ink-3)" : undefined }}>{t.title}</div>
                  {t.due_at && <small>{when(t.due_at, profile.timezone, false)}</small>}
                </div>
              ))}
            </div>
            {g.notes && <details style={{ marginTop: 8 }}><summary className="muted">Progress notes</summary><pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{g.notes}</pre></details>}
            <div className="row wrap" style={{ marginTop: 10 }}>
              <button className="btn sm" onClick={() => go(`chat?q=${encodeURIComponent(`Check in on my goal: ${g.title}`)}`)}>Check in</button>
              {g.status === "active" ? <button className="btn ghost sm" onClick={() => setStatus(g, "paused")}>Pause</button> : <button className="btn ghost sm" onClick={() => setStatus(g, "active")}>Resume</button>}
              <button className="btn ghost sm" onClick={() => setStatus(g, "done")}>Mark achieved</button>
              <button className="btn ghost sm danger" onClick={() => setStatus(g, "dropped")}>Drop</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
