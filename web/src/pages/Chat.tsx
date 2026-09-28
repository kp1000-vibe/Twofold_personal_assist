import { useEffect, useRef, useState } from "react";
import { ErrorBox, fn, go, Markdown, MODEL_NAMES, Profile, supabase, usd } from "../lib";

type Msg = { id: string; role: "user" | "assistant"; content: string; meta: any; created_at: string };

const SUGGESTIONS = [
  "What needs my attention today?",
  "Remind me to call Mom on Sunday at 5pm",
  "Find a good sushi place near me for Friday at 7",
  "Which subscriptions am I paying for?",
  "Who have I not heard back from this week?",
];

const INTENT_LABEL: Record<string, string> = {
  chit_chat: "chat", remember: "memory", tasks: "tasks", email: "email", calendar: "calendar",
  research: "research", money: "money", errand: "errand", advice: "thinking",
};

export default function Chat({ profile, prefill }: { profile: Profile; prefill?: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState(prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    supabase.from("messages").select("*").order("created_at", { ascending: false }).limit(60).then(({ data }) => {
      setMsgs(((data ?? []) as Msg[]).reverse());
      setLoaded(true);
    });
  }, []);
  useEffect(() => { if (prefill) setText(prefill); }, [prefill]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => {
    const el = boxRef.current;
    if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }
  }, [text]);

  const send = async (t = text) => {
    const message = t.trim();
    if (!message || busy) return;
    setErr(null);
    setText("");
    if (window.location.hash.includes("?q=")) history.replaceState(null, "", "#/chat");
    const temp: Msg = { id: `tmp${Date.now()}`, role: "user", content: message, meta: {}, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, temp]);
    setBusy(true);
    try {
      const { message: reply } = await fn<{ message: Msg }>("chat", { message });
      setMsgs((m) => [...m, reply]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!confirm("Clear the whole conversation? Memories and tasks stay.")) return;
    await supabase.from("messages").delete().eq("user_id", profile.id);
    setMsgs([]);
  };

  return (
    <div className="chat">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <div>
          <h1>Hi{profile.display_name ? ` ${profile.display_name}` : ""}</h1>
          <p>Ask for anything. Drafts and bookings wait for your OK.</p>
        </div>
        {msgs.length > 0 && <button className="btn ghost sm" onClick={clear}>Clear chat</button>}
      </div>

      <div className="chat-log" ref={logRef}>
        {loaded && msgs.length === 0 && (
          <div className="empty" style={{ paddingTop: 60 }}>
            <div className="big">What can I take off your plate?</div>
            <div className="suggest">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.role === "assistant" ? <Markdown text={m.content} /> : m.content}
              {m.role === "assistant" && <Meta meta={m.meta} />}
            </div>
          </div>
        ))}
        {busy && (
          <div className="msg assistant"><div className="bubble"><span className="thinking"><i /><i /> thinking</span></div></div>
        )}
        <ErrorBox msg={err} />
      </div>

      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          ref={boxRef} rows={1} value={text} placeholder="Message Twofold" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn primary" disabled={busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}

function Meta({ meta }: { meta: any }) {
  if (!meta || !meta.intent) return null;
  return (
    <>
      {meta.sources?.length > 0 && (
        <div className="sources">
          {meta.sources.map((s: any) => <a key={s.url} href={s.url} target="_blank" rel="noopener" title={s.url}>{s.title}</a>)}
        </div>
      )}
      {meta.actions?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button className="btn sm gold" onClick={() => go("approvals")}>Review in Approvals ({meta.actions.length})</button>
        </div>
      )}
      <div className="meta-line" title="How this answer was made">
        <span className="bolt">⚡</span>
        <span>{meta.instinct === "jev" ? "Jev" : "instinct"} → {INTENT_LABEL[meta.intent] ?? meta.intent} in {meta.instinct_ms}ms</span>
        <span>·</span>
        <span>{MODEL_NAMES[meta.model] ?? meta.model}</span>
        {meta.memories_used > 0 && <><span>·</span><span>{meta.memories_used} memories</span></>}
        <span>·</span>
        <span>{usd(meta.cost_usd, 4)}</span>
      </div>
    </>
  );
}
