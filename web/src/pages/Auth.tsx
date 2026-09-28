import { useState } from "react";
import { go, Logo, supabase } from "../lib";

export default function Auth({ mode, onDone }: { mode: "signin" | "signup" | "reset"; onDone?: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      if (mode === "reset") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        onDone?.();
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { display_name: name.trim() || undefined }, emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        if (!data.session) setNote("Check your email to confirm your address, then sign in.");
        else go("chat");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        go("chat");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    if (!email) return setErr("Type your email first");
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    if (error) setErr(error.message);
    else setNote("Password reset link sent.");
  };

  return (
    <div className="center-box">
      <div style={{ marginBottom: 20 }}><Logo /></div>
      <form className="card" onSubmit={submit}>
        <h2>{mode === "signup" ? "Create your account" : mode === "reset" ? "Set a new password" : "Welcome back"}</h2>
        {mode === "signup" && <p className="ink2">You will enter your invite code on the next screen.</p>}
        {mode === "signup" && (
          <label className="field"><span>First name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        )}
        {mode !== "reset" && (
          <label className="field"><span>Email</span><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        )}
        <label className="field"><span>Password</span>
          <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
        </label>
        {err && <div className="error" style={{ marginBottom: 10 }}>{err}</div>}
        {note && <div className="success" style={{ marginBottom: 10 }}>{note}</div>}
        <button className="btn primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? "One sec" : mode === "signup" ? "Create account" : mode === "reset" ? "Save password" : "Sign in"}
        </button>
        {mode !== "reset" && (
          <div className="row spread" style={{ marginTop: 14, fontSize: 14 }}>
            {mode === "signin" ? <a href="#/signup">New here? Create account</a> : <a href="#/signin">Have an account? Sign in</a>}
            {mode === "signin" && <button type="button" className="btn ghost sm" onClick={forgot}>Forgot password</button>}
          </div>
        )}
      </form>
      <p style={{ textAlign: "center", marginTop: 14 }}><a href="#/" className="muted">Back</a></p>
    </div>
  );
}
