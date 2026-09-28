import { useState } from "react";
import { ErrorBox, fn, Loading, must, Profile, supabase, useLoad } from "../lib";

type Kind = "imessage" | "sms" | "whatsapp";
type Config = { channels: Record<Kind, { available: boolean; number: string | null }>; webhooks?: Record<string, string> };
type Channel = { id: string; kind: Kind; phone: string; notify: boolean; verified_at: string };

const LABEL: Record<Kind, string> = { imessage: "iMessage", sms: "Android SMS", whatsapp: "WhatsApp" };
const ICON: Record<Kind, string> = { imessage: "💬", sms: "📱", whatsapp: "🟢" };

export default function TextChannels({ profile }: { profile: Profile }) {
  const cfg = useLoad(() => fn<Config>("phone", { op: "config" }));
  const linked = useLoad(async () => must(await supabase.from("channels").select("*").order("created_at")) as Channel[]);
  const [kind, setKind] = useState<Kind>(/iphone|ipad|mac/i.test(navigator.userAgent) ? "imessage" : "sms");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const run = async (f: () => Promise<void>) => {
    setBusy(true); setErr(null); setOk(null);
    try { await f(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const send = () => run(async () => {
    const r = await fn<{ phone: string }>("phone", { op: "start", kind, phone });
    setSentTo(r.phone); setCode("");
  });
  const verify = () => run(async () => {
    await fn("phone", { op: "verify", kind, phone: sentTo, code });
    setOk(`Linked. Check ${LABEL[kind]}, Twofold just said hi.`);
    setSentTo(null); setPhone(""); setCode("");
    linked.reload();
  });
  const remove = async (c: Channel) => {
    if (!confirm(`Unlink ${c.phone} from ${LABEL[c.kind]}?`)) return;
    await supabase.from("channels").delete().eq("id", c.id);
    linked.reload();
  };
  const toggle = async (c: Channel) => {
    await supabase.from("channels").update({ notify: !c.notify }).eq("id", c.id);
    linked.reload();
  };

  const conf = cfg.data?.channels;
  const anyOn = conf && Object.values(conf).some((c) => c.available);
  const list = linked.data ?? [];

  return (
    <div className="card">
      <h2>Text Twofold</h2>
      <p className="ink2" style={{ marginTop: 0 }}>Chat from iMessage, Android SMS or WhatsApp. Same memory, same rules, and you can approve drafts by replying YES.</p>

      {list.map((c) => (
        <div key={c.id} className="item" style={{ padding: "8px 0" }}>
          <span style={{ fontSize: 20 }}>{ICON[c.kind]}</span>
          <div className="grow">
            <div className="title">{LABEL[c.kind]} · {c.phone}</div>
            <div className="sub">
              {conf?.[c.kind]?.number ? <>Text <strong>{conf[c.kind].number}</strong> to chat</> : "Linked"}
            </div>
          </div>
          <label className="row" style={{ gap: 6 }} title="Send reminders, the morning brief and alerts here">
            <input type="checkbox" checked={c.notify} onChange={() => toggle(c)} /><small>Alerts</small>
          </label>
          <button className="btn ghost sm danger" onClick={() => remove(c)}>Unlink</button>
        </div>
      ))}

      {cfg.loading ? <Loading /> : !anyOn ? (
        <div className="notice">Texting is being switched on. You will be able to link your number here soon.</div>
      ) : (
        <div style={{ marginTop: list.length ? 12 : 0 }}>
          <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
            {(Object.keys(LABEL) as Kind[]).map((k) => (
              <button key={k} type="button" className={`btn sm ${kind === k ? "primary" : ""}`} disabled={!conf![k].available || !!sentTo}
                onClick={() => setKind(k)} title={conf![k].available ? "" : "Coming soon"}>
                {ICON[k]} {LABEL[k]}{conf![k].available ? "" : " (soon)"}
              </button>
            ))}
          </div>
          {kind === "whatsapp" && (
            <div className="notice" style={{ marginBottom: 10 }}>Meta only lets AI assistants on WhatsApp in the EU and a few other places right now. In the US, use iMessage or SMS.</div>
          )}
          {!sentTo ? (
            <form className="row wrap" onSubmit={(e) => { e.preventDefault(); send(); }}>
              <input className="input grow" style={{ minWidth: 200 }} inputMode="tel" autoComplete="tel" placeholder="+1 510 555 0100" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <button className="btn primary" disabled={busy || phone.replace(/\D/g, "").length < 7}>{busy ? "Sending" : "Send code"}</button>
            </form>
          ) : (
            <form className="row wrap" onSubmit={(e) => { e.preventDefault(); verify(); }}>
              <input className="input" style={{ width: 140, letterSpacing: 4 }} inputMode="numeric" autoComplete="one-time-code" maxLength={8} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              <button className="btn primary" disabled={busy || code.length < 4}>{busy ? "Checking" : "Verify"}</button>
              <button type="button" className="btn ghost" onClick={() => { setSentTo(null); setErr(null); }}>Change number</button>
              <small className="muted" style={{ flexBasis: "100%" }}>We sent a code to {sentTo} by {kind === "whatsapp" ? "WhatsApp" : kind === "imessage" ? "iMessage" : "text"}.</small>
            </form>
          )}
          <small className="muted" style={{ display: "block", marginTop: 8 }}>Message and data rates may apply. Reply STOP to pause alerts, HELP for help.</small>
        </div>
      )}
      <ErrorBox msg={err} />
      {ok && <div className="success" style={{ marginTop: 8 }}>{ok}</div>}

      {profile.is_admin && cfg.data?.webhooks && (
        <details style={{ marginTop: 12 }}>
          <summary className="muted">Admin: webhook URLs</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <small>Twilio (SMS and WhatsApp, "A message comes in", HTTP POST):</small>
            <code className="mono" style={{ wordBreak: "break-all" }}>{cfg.data.webhooks.twilio}</code>
            <small>Sendblue (inbound message webhook):</small>
            <code className="mono" style={{ wordBreak: "break-all" }}>{cfg.data.webhooks.sendblue}</code>
          </div>
        </details>
      )}
    </div>
  );
}
