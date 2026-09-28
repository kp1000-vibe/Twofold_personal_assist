import { useEffect, useRef, useState } from "react";
import { ErrorBox, fn, go, Markdown, MODEL_NAMES, Profile, supabase, usd } from "../lib";

type Msg = { id: string; role: "user" | "assistant"; content: string; meta: any; created_at: string };

const SUGGESTIONS = [
  "What needs my attention today?",
  "Can I afford a $1.2M house?",
  "I want to run a half marathon by spring",
  "Every Friday at 4pm, summarize my week",
  "Where could my week break?",
  "I decided to lease an EV to save on gas",
];

const INTENT_LABEL: Record<string, string> = {
  chit_chat: "chat", remember: "memory", people: "people", tasks: "tasks", goals: "goals", email: "email", calendar: "calendar",
  research: "research", shopping: "shopping", travel: "travel", money: "finance", errand: "concierge", career: "career",
  automation: "automation", recall: "recall", advice: "thinking",
};
const MAX_FILE = 20 * 1024 * 1024;

export default function Chat({ profile, prefill }: { profile: Profile; prefill?: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState(prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    supabase.from("messages").select("*").order("created_at", { ascending: false }).limit(60).then(({ data }) => {
      setMsgs(((data ?? []) as Msg[]).reverse());
      setLoaded(true);
    });
  }, []);
  useEffect(() => { if (prefill) setText(prefill); }, [prefill]);
  // background job results arrive as new assistant messages
  useEffect(() => {
    const ch = supabase.channel("chat-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `user_id=eq.${profile.id}` }, (p: any) => {
        const m = p.new as Msg;
        if (m.role === "assistant" && m.meta?.background) setMsgs((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile.id]);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => {
    const el = boxRef.current;
    if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 160)}px`; }
  }, [text]);

  const pick = (list: FileList | null) => {
    if (!list) return;
    const ok = Array.from(list).filter((f) => (f.type.startsWith("image/") || f.type === "application/pdf") && f.size <= MAX_FILE);
    if (ok.length < list.length) setErr("Only images and PDFs up to 20 MB can be attached.");
    setFiles((cur) => [...cur, ...ok].slice(0, 5));
  };

  const send = async (t = text) => {
    const message = t.trim();
    if ((!message && !files.length) || busy) return;
    setErr(null);
    setText("");
    const sending = files;
    setFiles([]);
    if (window.location.hash.includes("?q=")) history.replaceState(null, "", "#/chat");
    const temp: Msg = { id: `tmp${Date.now()}`, role: "user", content: message || "Please look at the attached file.", meta: { attachments: sending.map((f) => ({ name: f.name, mime: f.type })) }, created_at: new Date().toISOString() };
    setMsgs((m) => [...m, temp]);
    setBusy(true);
    try {
      const attachments = [];
      for (const f of sending) {
        const path = `${profile.id}/${crypto.randomUUID()}-${f.name.replace(/[^\w.]+/g, "_").slice(-80)}`;
        const { error } = await supabase.storage.from("uploads").upload(path, f, { contentType: f.type });
        if (error) throw new Error(`Upload failed: ${error.message}`);
        attachments.push({ path, name: f.name, mime: f.type });
      }
      const { message: reply } = await fn<{ message: Msg }>("chat", { message, attachments });
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
              {m.meta?.attachments?.length > 0 && (
                <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
                  {m.meta.attachments.map((a: any, i: number) => <span key={i} className="chip">{a.mime === "application/pdf" ? "📄" : "🖼"} {a.name}</span>)}
                </div>
              )}
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

      {files.length > 0 && (
        <div className="row wrap" style={{ gap: 6, marginBottom: 6 }}>
          {files.map((f, i) => <span key={i} className="chip">{f.name} <button type="button" className="btn ghost sm" style={{ padding: "0 4px" }} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}
        </div>
      )}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        <button type="button" className="btn ghost" title="Attach a photo or PDF" onClick={() => fileRef.current?.click()}>📎</button>
        <textarea
          ref={boxRef} rows={1} value={text} placeholder="Message Twofold" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button className="btn primary" disabled={busy || (!text.trim() && !files.length)}>Send</button>
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
        {meta.background && <span className="chip gold">background</span>}
        {meta.lite && <span className="chip warn" title="Past this month's allowance: lighter model, no web search">lite mode</span>}
        {meta.channel && <span className="chip">via {meta.channel === "imessage" ? "iMessage" : meta.channel === "whatsapp" ? "WhatsApp" : "SMS"}</span>}
        <span>{meta.instinct === "jev" ? "Jev" : "instinct"} → {(meta.specialists ?? [meta.intent]).map((x: string) => INTENT_LABEL[x] ?? x).join(" + ")} in {meta.instinct_ms}ms</span>
        <span>·</span>
        <span>{MODEL_NAMES[meta.model] ?? meta.model}</span>
        {meta.memories_used > 0 && <><span>·</span><span>{meta.memories_used} memories</span></>}
        <span>·</span>
        <span>{usd(meta.cost_usd, 4)}</span>
      </div>
    </>
  );
}
