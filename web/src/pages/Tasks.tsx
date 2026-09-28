import { useState } from "react";
import { Empty, ErrorBox, fromLocalInput, Loading, must, Profile, supabase, useLoad, when } from "../lib";

type Task = { id: string; title: string; notes: string | null; kind: string; due_at: string | null; remind_at: string | null; status: string; source: string; completed_at: string | null };

export default function Tasks({ profile }: { profile: Profile }) {
  const open = useLoad(async () => must(await supabase.from("tasks").select("*").eq("status", "open").order("due_at", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false })) as Task[]);
  const done = useLoad(async () => must(await supabase.from("tasks").select("*").eq("status", "done").order("completed_at", { ascending: false }).limit(10)) as Task[]);
  const [title, setTitle] = useState("");
  const [at, setAt] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const iso = fromLocalInput(at, profile.timezone);
    const { error } = await supabase.from("tasks").insert({
      user_id: profile.id, title: title.trim(), kind: iso ? "reminder" : "todo", due_at: iso, remind_at: iso, source: "manual",
    });
    if (error) return setErr(error.message);
    setTitle("");
    setAt("");
    open.reload();
  };

  const set = async (t: Task, status: "done" | "dismissed") => {
    await supabase.from("tasks").update({ status, completed_at: new Date().toISOString() }).eq("id", t.id);
    open.reload();
    done.reload();
  };

  const list = open.data ?? [];
  const followups = list.filter((t) => t.kind === "follow_up");
  const rest = list.filter((t) => t.kind !== "follow_up");

  const Row = ({ t }: { t: Task }) => {
    const overdue = t.due_at && new Date(t.due_at).getTime() < Date.now();
    return (
      <div className="item">
        <button className="check" title="Done" onClick={() => set(t, "done")} aria-label="Mark done" />
        <div className="grow">
          <div className="title">{t.title}</div>
          <div className="sub">
            {t.due_at && <span style={{ color: overdue ? "var(--bad)" : undefined }}>{overdue ? "Overdue · " : ""}{when(t.due_at, profile.timezone)}</span>}
            {t.remind_at && !t.due_at && <span>Reminder {when(t.remind_at, profile.timezone)}</span>}
            {t.source === "email" && <span> · from email</span>}
            {t.notes && <span> · {t.notes}</span>}
          </div>
        </div>
        <button className="btn ghost sm" onClick={() => set(t, "dismissed")}>Dismiss</button>
      </div>
    );
  };

  return (
    <div>
      <div className="page-head"><div><h1>Tasks</h1><p>Todos, reminders, and threads waiting on a reply.</p></div></div>
      <form className="card row wrap" onSubmit={add} style={{ marginBottom: 14 }}>
        <input className="input grow" style={{ minWidth: 200 }} placeholder="Add a todo, like Renew passport" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input" style={{ flex: "0 1 220px" }} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} title="Remind me at" />
        <button className="btn primary">Add</button>
      </form>
      <ErrorBox msg={err} />
      {open.loading ? <Loading /> : (
        <>
          <div className="card" style={{ padding: "4px 14px" }}>
            {rest.length === 0 ? <Empty title="Clear list">Tell the chat "remind me to..." or add one above.</Empty> : rest.map((t) => <Row key={t.id} t={t} />)}
          </div>
          <h2 style={{ marginTop: 26 }}>Waiting on a reply</h2>
          <div className="card" style={{ padding: "4px 14px" }}>
            {followups.length === 0 ? <Empty title="Nobody is ghosting you">When an email you sent gets no answer in 3 days, it shows up here.</Empty> : followups.map((t) => <Row key={t.id} t={t} />)}
          </div>
        </>
      )}
      {(done.data ?? []).length > 0 && (
        <details style={{ marginTop: 22 }}>
          <summary className="muted">Recently done</summary>
          <div className="card" style={{ padding: "4px 14px", marginTop: 8 }}>
            {(done.data ?? []).map((t) => <div key={t.id} className="item"><span className="chip good">done</span><div className="grow" style={{ textDecoration: "line-through", color: "var(--ink-3)" }}>{t.title}</div></div>)}
          </div>
        </details>
      )}
    </div>
  );
}
