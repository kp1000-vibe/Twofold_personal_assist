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
          <h1>The family that runs itself.</h1>
          <p className="lede">
            Twofold is the AI that runs your home with you. Groceries, chores, pickups, bills and birthdays in one place the whole family shares.
            It catches the dropped ball before it drops, and nothing goes out without your OK.
          </p>
          {state === "done" ? (
            <div className="success" style={{ marginTop: 18 }}>You are on the list. We will email your invite code.</div>
          ) : (
            <form onSubmit={join} className="card" style={{ marginTop: 20, maxWidth: 480 }}>
              <div className="row wrap">
                <input className="input grow" style={{ minWidth: 180 }} placeholder="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                <input className="input" style={{ flex: "0 1 160px" }} placeholder="First name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <textarea className="input" style={{ marginTop: 8 }} rows={2} placeholder="What falls through the cracks at home? (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
              <div className="row spread" style={{ marginTop: 10 }}>
                <small>No spam. One email when your spot opens.</small>
                <button className="btn gold" disabled={state === "busy"}>Request invite</button>
              </div>
              {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
            </form>
          )}
        </div>

        <div className="demo" aria-label="Example of what Twofold does">
          <div className="line"><span className="chip warn">week check</span><div>Tuesday breaks: both of you are in meetings at 3:30 and <b>nobody has soccer pickup</b>.</div></div>
          <div className="line"><span className="chip good">family chat</span><div>Added milk, eggs and diapers to groceries. Sam is at the store now.</div></div>
          <div className="line"><span className="chip">chores</span><div>Trash is done by Ria. Dishes rotate to Arjun tomorrow.</div></div>
          <div className="line"><span className="chip gold">money</span><div>Costco run $142 split two ways. Sam owes you $71.</div></div>
          <div className="line"><span className="chip">drafted</span><div>Reply to the school about the field trip form, <b>waiting for your OK</b>.</div></div>
        </div>
      </section>

      <section className="steps">
        <div className="card"><div className="num">1</div><h3>One home base</h3><p className="ink2">Invite your partner and teens. Groceries, chores, the family calendar, rides and shared bills live in one place everyone can see.</p></div>
        <div className="card"><div className="num">2</div><h3>Just ask</h3><p className="ink2">Say "@twofold who is driving Saturday" or "split the Costco run" in the family chat. It handles it, and your private stuff stays private.</p></div>
        <div className="card"><div className="num">3</div><h3>Sunday week check</h3><p className="ink2">Every Sunday it walks through the coming week and tells you the few spots that will break, with fixes ready to approve.</p></div>
      </section>

      <section className="trust">
        <div className="card"><h3>Private by default</h3><p className="ink2">Your email, chats and memories are yours. Only what you put on family lists, the family calendar or the family chat is shared. Teens get safety filters and parents approve every invite.</p></div>
        <div className="card"><h3>Built to resist tricks</h3><p className="ink2">Every email is screened for hidden instructions aimed at AI before the assistant ever reads it, and email text is always treated as data.</p></div>
      </section>

      <p className="muted" style={{ textAlign: "center", marginTop: 48 }}>Twofold. The family that runs itself. · <a href="#/privacy">Privacy</a></p>
    </div>
  );
}
