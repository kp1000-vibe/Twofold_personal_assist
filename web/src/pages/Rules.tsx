import { useState } from "react";
import { ago, Empty, ErrorBox, go, Loading, must, supabase, useLoad } from "../lib";

type Rule = { id: string; rule: string; mode: string; applies_to: string; enabled: boolean };
type Auto = { id: string; title: string; trigger: string; condition: string | null; instruction: string; hour: number | null; weekday: number | null; mode: string; enabled: boolean; runs: number; last_run_at: string | null };

const MODE_LABEL: Record<string, string> = { auto: "Do it (5 min to undo)", ask: "Always ask me", never: "Never do it" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const EXAMPLES = ["Replies to my family", "Calendar invites for kids activities", "Emails to anyone at my work", "Anything involving money"];

export default function Rules() {
  const rules = useLoad(async () => must(await supabase.from("policies").select("*").order("created_at")) as Rule[]);
  const autos = useLoad(async () => must(await supabase.from("automations").select("*").order("created_at")) as Auto[]);
  const [text, setText] = useState("");
  const [mode, setMode] = useState("ask");
  const [applies, setApplies] = useState("any");
  const [err, setErr] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim().length < 3) return;
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("policies").insert({ user_id: u.user!.id, rule: text.trim(), mode, applies_to: applies });
    if (error) return setErr(error.message);
    setText("");
    rules.reload();
  };
  const toggleRule = async (r: Rule) => { await supabase.from("policies").update({ enabled: !r.enabled }).eq("id", r.id); rules.reload(); };
  const delRule = async (r: Rule) => { await supabase.from("policies").delete().eq("id", r.id); rules.reload(); };
  const toggleAuto = async (a: Auto) => { await supabase.from("automations").update({ enabled: !a.enabled }).eq("id", a.id); autos.reload(); };
  const delAuto = async (a: Auto) => { if (confirm(`Delete automation "${a.title}"?`)) { await supabase.from("automations").delete().eq("id", a.id); autos.reload(); } };

  return (
    <div>
      <div className="page-head"><div><h1>Rules</h1><p>Your trust rules and automations. With no rule, Twofold always asks.</p></div></div>

      <form className="card" onSubmit={add}>
        <h2>Trust rules</h2>
        <p className="ink2">Write a rule in plain words. Jev checks every email and invite against your rules before anything happens.</p>
        <div className="row wrap">
          <input className="input grow" style={{ minWidth: 220 }} placeholder="Like: Replies to my family" value={text} onChange={(e) => setText(e.target.value)} />
          <select className="input" style={{ flex: "0 1 190px" }} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="auto">{MODE_LABEL.auto}</option><option value="ask">{MODE_LABEL.ask}</option><option value="never">{MODE_LABEL.never}</option>
          </select>
          <select className="input" style={{ flex: "0 1 150px" }} value={applies} onChange={(e) => setApplies(e.target.value)}>
            <option value="any">Emails and events</option><option value="send_email">Emails only</option><option value="create_event">Events only</option>
          </select>
          <button className="btn primary">Add rule</button>
        </div>
        <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>{EXAMPLES.map((x) => <button type="button" key={x} className="chip" style={{ border: 0 }} onClick={() => setText(x)}>{x}</button>)}</div>
        <ErrorBox msg={err} />
        <div style={{ marginTop: 10 }}>
          {rules.loading ? <Loading /> : (rules.data ?? []).length === 0 ? <Empty title="No rules yet">Everything waits for your OK.</Empty> : (rules.data ?? []).map((r) => (
            <div key={r.id} className="item" style={{ opacity: r.enabled ? 1 : 0.5 }}>
              <span className={`chip ${r.mode === "auto" ? "good" : r.mode === "never" ? "bad" : "gold"}`}>{r.mode}</span>
              <div className="grow"><div className="title">{r.rule}</div><div className="sub">{MODE_LABEL[r.mode]} · {r.applies_to === "any" ? "emails and events" : r.applies_to === "send_email" ? "emails" : "events"}</div></div>
              <button className="btn ghost sm" onClick={() => toggleRule(r)}>{r.enabled ? "Pause" : "Resume"}</button>
              <button className="btn ghost sm danger" onClick={() => delRule(r)}>Delete</button>
            </div>
          ))}
        </div>
      </form>

      <div className="card">
        <div className="row spread"><h2 style={{ margin: 0 }}>Automations</h2><button className="btn sm" onClick={() => go(`chat?q=${encodeURIComponent("Set up an automation: ")}`)}>New in chat</button></div>
        <p className="ink2">Describe a repeated job in chat, like "every Friday at 4, summarize my week" or "when a bill arrives, add a task to pay it".</p>
        {autos.loading ? <Loading /> : (autos.data ?? []).length === 0 ? <Empty title="No automations yet" /> : (autos.data ?? []).map((a) => (
          <div key={a.id} className="item" style={{ opacity: a.enabled ? 1 : 0.5 }}>
            <span className="chip">{a.trigger === "email" ? "on email" : a.trigger === "daily" ? `daily ${a.hour}:00` : `${DAYS[a.weekday ?? 1]} ${a.hour}:00`}</span>
            <div className="grow">
              <div className="title">{a.title}</div>
              <div className="sub">{a.condition ? `When: ${a.condition} · ` : ""}Do: {a.instruction}</div>
              <div className="sub">{a.mode === "auto" ? "Follows your trust rules" : "Always asks first"} · ran {a.runs} times{a.last_run_at ? `, last ${ago(a.last_run_at)}` : ""}</div>
            </div>
            <button className="btn ghost sm" onClick={() => toggleAuto(a)}>{a.enabled ? "Pause" : "Resume"}</button>
            <button className="btn ghost sm danger" onClick={() => delAuto(a)}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
