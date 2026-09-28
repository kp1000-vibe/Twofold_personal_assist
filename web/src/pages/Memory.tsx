import { useState } from "react";
import { ago, Empty, Loading, must, supabase, useLoad } from "../lib";

type Mem = { id: string; content: string; category: string; kind: string; reason: string | null; source: string; created_at: string; last_used_at: string | null };

export default function Memory() {
  const mems = useLoad(async () => must(await supabase.from("memories").select("*").order("created_at", { ascending: false })) as Mem[]);
  const [text, setText] = useState("");

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const { data: u } = await supabase.auth.getUser();
    await supabase.from("memories").insert({ user_id: u.user!.id, content: text.trim().slice(0, 500), source: "manual" });
    setText("");
    mems.reload();
  };
  const remove = async (m: Mem) => {
    await supabase.from("memories").delete().eq("id", m.id);
    mems.reload();
  };

  return (
    <div>
      <div className="page-head"><div><h1>Memory</h1><p>Everything Twofold knows about you. Delete anything, anytime.</p></div></div>
      <form className="card row" onSubmit={add} style={{ marginBottom: 14 }}>
        <input className="input grow" placeholder="Add something, like I am vegetarian, or My sister is Anya" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn primary">Add</button>
      </form>
      <div className="card" style={{ padding: "4px 14px" }}>
        {mems.loading ? <Loading /> : (mems.data ?? []).length === 0 ? (
          <Empty title="Nothing yet">Tell the chat things like "I prefer morning meetings" and it will remember.</Empty>
        ) : (mems.data ?? []).map((m) => (
          <div key={m.id} className="item">
            <div className="grow">
              <div>{m.kind === "decision" && <span className="chip gold" style={{ marginRight: 6 }}>decision</span>}{m.content}</div>
              {m.reason && <div className="sub">Why: {m.reason}</div>}
              <div className="sub">{m.kind} · added {ago(m.created_at)}{m.last_used_at ? ` · last used ${ago(m.last_used_at)}` : ""}</div>
            </div>
            <button className="btn ghost sm danger" onClick={() => remove(m)}>Forget</button>
          </div>
        ))}
      </div>
    </div>
  );
}
