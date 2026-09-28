import { useState } from "react";
import { ago, Empty, ErrorBox, fn, Loading, must, supabase, useLoad } from "../lib";

type Act = { id: string; kind: string; title: string; why: string | null; undo: any; undone_at: string | null; created_at: string };

const KIND_CHIP: Record<string, string> = {
  email_sent: "good", event_created: "good", scheduled: "gold", blocked: "bad", failed: "bad", undone: "", insight: "gold",
};

export default function Activity() {
  const list = useLoad(async () => must(await supabase.from("activity").select("*").order("created_at", { ascending: false }).limit(150)) as Act[]);
  const [err, setErr] = useState<string | null>(null);

  const undo = async (a: Act) => {
    setErr(null);
    try {
      await fn("undo", { activity_id: a.id });
      list.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="page-head"><div><h1>Activity</h1><p>Everything Twofold did, and why. Undo what can be undone.</p></div></div>
      <ErrorBox msg={err} />
      <div className="card" style={{ padding: "4px 14px" }}>
        {list.loading ? <Loading /> : (list.data ?? []).length === 0 ? <Empty title="Nothing yet">Actions, reminders and automations will show up here.</Empty> : (list.data ?? []).map((a) => (
          <div key={a.id} className="item" style={{ opacity: a.undone_at ? 0.5 : 1 }}>
            <span className={`chip ${KIND_CHIP[a.kind] ?? ""}`}>{a.kind.replace(/_/g, " ")}</span>
            <div className="grow">
              <div className="title" style={{ textDecoration: a.undone_at ? "line-through" : undefined }}>{a.title}</div>
              {a.why && <div className="sub">Why: {a.why}</div>}
            </div>
            <div style={{ textAlign: "right" }}>
              <small>{ago(a.created_at)}</small>
              {a.undo && !a.undone_at && <div><button className="btn ghost sm" onClick={() => undo(a)}>Undo</button></div>}
              {a.undone_at && <div><small>undone</small></div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
