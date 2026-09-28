import { useMemo, useState } from "react";
import { ago, ErrorBox, fn, Loading, must, Profile, supabase, useLoad } from "../lib";

export default function Settings({ profile, onSaved, params }: { profile: Profile; onSaved: () => void; params: URLSearchParams }) {
  const [name, setName] = useState(profile.display_name ?? "");
  const [tz, setTz] = useState(profile.timezone);
  const [hour, setHour] = useState(profile.brief_hour);
  const [remindEmail, setRemindEmail] = useState(profile.remind_by_email);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const google = useLoad(async () => must(await supabase.rpc("my_google_status")) as any);
  const zones = useMemo(() => {
    try { return (Intl as any).supportedValuesOf("timeZone") as string[]; } catch { return [profile.timezone]; }
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const { error } = await supabase.from("profiles").update({ display_name: name.trim() || null, timezone: tz, brief_hour: hour, remind_by_email: remindEmail }).eq("id", profile.id);
    if (error) return setErr(error.message);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onSaved();
  };

  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { url } = await fn<{ url: string }>("google-oauth");
      window.location.href = url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!confirm("Disconnect Google? Twofold stops reading mail and your calendar right away.")) return;
    await supabase.rpc("disconnect_google");
    google.reload();
  };

  const g = google.data;
  const flash = params.get("google");

  return (
    <div>
      <div className="page-head"><div><h1>Settings</h1></div></div>

      <div className="card">
        <h2>Google</h2>
        {flash === "connected" && <div className="success" style={{ marginBottom: 10 }}>Google connected. Your inbox will be sorted within 10 minutes.{params.get("missing") ? ` Some permissions were skipped: ${params.get("missing")}.` : ""}</div>}
        {flash === "error" && <div className="error" style={{ marginBottom: 10 }}>Could not connect: {params.get("msg")}</div>}
        {google.loading ? <Loading /> : g?.connected ? (
          <div className="row spread wrap">
            <div><strong>{g.email}</strong><div className="muted">Gmail and Calendar connected{g.last_sync_at ? ` · last sync ${ago(g.last_sync_at)}` : ""}</div></div>
            <div className="row"><button className="btn" onClick={connect} disabled={busy}>Reconnect</button><button className="btn ghost danger" onClick={disconnect}>Disconnect</button></div>
          </div>
        ) : g?.slot ? (
          <div className="row spread wrap">
            <p className="ink2" style={{ margin: 0 }}>Connect Gmail and Calendar so Twofold can sort mail, draft replies and plan your day. It only sends things you approve.</p>
            <button className="btn primary" onClick={connect} disabled={busy}>{busy ? "Opening Google" : "Connect Google"}</button>
          </div>
        ) : (
          <div className="notice">Gmail access is rolling out to the first 100 beta testers while Google reviews the app. You are on the list, and everything else works today.</div>
        )}
      </div>

      <form className="card" onSubmit={save}>
        <h2>You</h2>
        <label className="field"><span>First name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Timezone</span>
          <select className="input" value={tz} onChange={(e) => setTz(e.target.value)}>{zones.map((z) => <option key={z}>{z}</option>)}</select>
        </label>
        <label className="field"><span>Morning brief at</span>
          <select className="input" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric" })}</option>)}
          </select>
        </label>
        <label className="row" style={{ marginBottom: 14 }}>
          <input type="checkbox" checked={remindEmail} onChange={(e) => setRemindEmail(e.target.checked)} />
          <span>Also email me my reminders (to my connected Gmail)</span>
        </label>
        <ErrorBox msg={err} />
        <div className="row"><button className="btn primary">Save</button>{saved && <span className="chip good">Saved</span>}</div>
      </form>

      <div className="card">
        <h2>More</h2>
        <div className="row wrap">
          <a className="btn" href="#/money">Money</a>
          <a className="btn" href="#/memory">Memory</a>
          {profile.is_admin && <a className="btn" href="#/admin">Admin</a>}
          <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
