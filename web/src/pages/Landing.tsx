import { useState } from "react";
import { Logo, supabase } from "../lib";

export default function Landing() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [why, setWhy] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setState("busy");
    const { error } = await supabase.from("waitlist").insert({ email: email.trim().toLowerCase(), name: name.trim() || null, why: why.trim() || null });
    if (error && !/duplicate/i.test(error.message)) {
      setErr("Could not save that, check the email and try again.");
      setState("idle");
      return;
    }
    setState("done");
  };

  return (
    <div className="landing">
      <nav>
        <Logo />
        <div className="row">
          <a className="btn ghost" href="#/signin">Sign in</a>
          <a className="btn primary" href="#/signup">I have an invite</a>
        </div>
      </nav>

      <section className="hero">
        <div>
          <span className="kicker">Private beta · 1,000 spots</span>
          <h1>An assistant with instincts.</h1>
          <p className="lede">
            Twofold sorts your inbox, keeps track of who owes who a reply, plans your day and preps the busywork.
            It reacts in a blink and thinks hard only when it matters. Nothing goes out without your OK.
          </p>
          {state === "done" ? (
            <div className="success" style={{ marginTop: 18 }}>You are on the list. We will email your invite code.</div>
          ) : (
            <form onSubmit={join} className="card" style={{ marginTop: 20, maxWidth: 480 }}>
              <div className="row wrap">
                <input className="input grow" style={{ minWidth: 180 }} placeholder="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                <input className="input" style={{ flex: "0 1 160px" }} placeholder="First name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <textarea className="input" style={{ marginTop: 8 }} rows={2} placeholder="What would you hand off first? (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
              <div className="row spread" style={{ marginTop: 10 }}>
                <small>No spam. One email when your spot opens.</small>
                <button className="btn gold" disabled={state === "busy"}>Request invite</button>
              </div>
              {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
            </form>
          )}
        </div>

        <div className="demo" aria-label="Example of what Twofold does">
          <div className="line"><span className="chip gold">instinct 0.3s</span><div>Sorted 41 new emails. 3 need you today.</div></div>
          <div className="line"><span className="chip">drafted</span><div>Reply to Priya about Thursday dinner, <b>waiting for your OK</b>.</div></div>
          <div className="line"><span className="chip warn">follow up</span><div>The landlord has not answered your repair request in 4 days.</div></div>
          <div className="line"><span className="chip good">saved</span><div>Found 6 subscriptions. Streaming renews Friday for $22.99.</div></div>
          <div className="line"><span className="chip">errand</span><div>Three sushi spots open Friday at 7 with booking links ready.</div></div>
        </div>
      </section>

      <section className="steps">
        <div className="card"><div className="num">1</div><h3>Instinct</h3><p className="ink2">A fast decision model reads every email and message the moment it lands. What is it, how urgent, does it need a reply, is it a trick. Fractions of a cent each.</p></div>
        <div className="card"><div className="num">2</div><h3>Thinking</h3><p className="ink2">Only when writing or planning is needed does Claude step in, with just the context and tools that job needs. Small jobs get a small model.</p></div>
        <div className="card"><div className="num">3</div><h3>Your OK</h3><p className="ink2">Emails, calendar invites and errands wait in one Approvals tab. You edit, approve or toss. Nothing is sent, booked or bought behind your back.</p></div>
      </section>

      <section className="trust">
        <div className="card"><h3>You can see what it knows</h3><p className="ink2">Every memory is listed and deletable. Email text is trimmed to short excerpts and cleared after 30 days.</p></div>
        <div className="card"><h3>Built to resist tricks</h3><p className="ink2">Every email is screened for hidden instructions aimed at AI before the assistant ever reads it, and email text is always treated as data.</p></div>
      </section>

      <p className="muted" style={{ textAlign: "center", marginTop: 48 }}>Twofold · private beta · <a href="#/privacy">Privacy</a></p>
    </div>
  );
}
