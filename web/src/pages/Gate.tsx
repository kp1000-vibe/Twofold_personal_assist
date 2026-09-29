import { useState } from "react";
import { Logo, supabase } from "../lib";

export default function Gate({ onJoined }: { onJoined: () => void }) {
  const [code, setCode] = useState(localStorage.getItem("twofold_invite") ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const redeem = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await supabase.rpc("redeem_invite", { p_code: code.trim() });
    setBusy(false);
    if (error) return setErr(error.message);
    localStorage.removeItem("twofold_invite");
    onJoined();
  };

  return (
    <div className="center-box">
      <div style={{ marginBottom: 20 }}><Logo /></div>
      <form className="card" onSubmit={redeem}>
        <h2>Enter your invite code</h2>
        <p className="ink2">The family that runs itself. Twofold is invite only while we tune it with the first families. A family invite from someone in your home works here too.</p>
        <input className="input mono" style={{ textTransform: "uppercase", letterSpacing: "0.08em" }} placeholder="TWO1A2B3C4D" value={code} onChange={(e) => setCode(e.target.value)} required />
        {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}
        <button className="btn primary" style={{ width: "100%", marginTop: 12 }} disabled={busy}>{busy ? "Checking" : "Join the beta"}</button>
        <p className="muted" style={{ marginTop: 14, fontSize: 14 }}>No code yet? <a href="#/" onClick={() => supabase.auth.signOut()}>Join the waitlist</a></p>
      </form>
      <p style={{ textAlign: "center", marginTop: 14 }}><button className="btn ghost sm" onClick={() => supabase.auth.signOut()}>Sign out</button></p>
    </div>
  );
}
