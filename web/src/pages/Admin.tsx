import { useState } from "react";
import { ago, ErrorBox, Loading, MODEL_NAMES, must, supabase, useLoad, usd } from "../lib";

export default function Admin() {
  const m = useLoad(async () => must(await supabase.rpc("admin_metrics")) as any);
  const wait = useLoad(async () => must(await supabase.from("waitlist").select("*").order("created_at", { ascending: false }).limit(300)) as any[]);
  const users = useLoad(async () => must(await supabase.rpc("admin_list_users")) as any[]);
  const [count, setCount] = useState(10);
  const [note, setNote] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [invited, setInvited] = useState<Record<string, string>>({});

  const make = async () => {
    setErr(null);
    const { data, error } = await supabase.rpc("admin_create_invites", { p_count: count, p_note: note || null, p_max_uses: 1 });
    if (error) return setErr(error.message);
    setCodes(data as string[]);
  };
  const invite = async (w: any) => {
    const { data, error } = await supabase.rpc("admin_invite_waitlist", { p_id: w.id });
    if (error) return setErr(error.message);
    setInvited((x) => ({ ...x, [w.id]: data as string }));
    wait.reload();
  };
  const slot = async (u: any, on: boolean) => {
    const { error } = await supabase.rpc("admin_set_google_slot", { p_user: u.id, p_on: on });
    if (error) return setErr(error.message);
    users.reload();
    m.reload();
  };

  const link = (code: string) => `${window.location.origin}/?invite=${code}`;
  const mailto = (email: string, name: string | null, code: string) =>
    `mailto:${email}?subject=${encodeURIComponent("Your Twofold invite")}&body=${encodeURIComponent(
      `Hi ${name ?? "there"},\n\nYour spot in the Twofold beta is open. Create your account here:\n${link(code)}\n\nYour invite code is ${code}.\n\nReply to this email with anything that feels off. Every note gets read.\n`,
    )}`;

  const x = m.data;
  const perUser = x && x.active_30d > 0 ? Number(x.cost_30d) / x.active_30d : 0;
  const baselinePerUser = x && x.active_30d > 0 ? Number(x.baseline_30d) / x.active_30d : 0;
  const savings = x && Number(x.baseline_30d) > 0 ? 1 - Number(x.cost_30d) / Number(x.baseline_30d) : 0;
  const jevShare = x && (x.jev_questions_30d + x.claude_calls_30d) > 0 ? x.jev_questions_30d / (x.jev_questions_30d + x.claude_calls_30d) : 0;

  return (
    <div>
      <div className="page-head"><div><h1>Admin</h1><p>Beta health and unit economics, last 30 days.</p></div><button className="btn" onClick={() => { m.reload(); users.reload(); wait.reload(); }}>Refresh</button></div>
      <ErrorBox msg={err ?? m.error} />
      {m.loading || !x ? <Loading /> : (
        <>
          <div className="grid cols-4">
            <Stat l="Beta users" v={`${x.beta_users} / ${x.beta_cap}`} s={`${x.users} signed up · ${x.waitlist_pending} waiting`} />
            <Stat l="Active 7 days" v={x.active_7d} s={`${x.active_30d} active in 30 days`} />
            <Stat l="Google connected" v={`${x.google_connected}`} s={`${x.google_slots_used} of ${x.google_slots} test slots used`} />
            <Stat l="AI cost 30 days" v={usd(x.cost_30d, 2)} s={`Jev ${usd(x.jev_cost_30d, 3)} · Claude ${usd(x.claude_cost_30d, 2)}`} />
            <Stat l="Cost per active user" v={`${usd(perUser, 2)}/mo`} s={`vs ${usd(baselinePerUser, 2)} without Jev routing`} />
            <Stat l="Saved by instinct layer" v={`${Math.round(savings * 100)}%`} s="estimate vs sending every call to Sonnet 5" />
            <Stat l="Decisions made by Jev" v={`${Math.round(jevShare * 100)}%`} s={`${x.jev_questions_30d.toLocaleString()} judgments · ${x.claude_calls_30d.toLocaleString()} Claude calls`} />
            <Stat l="Jev fallback calls" v={x.fallback_calls_30d} s="answered by Haiku because Jev key missing or down" />
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <h3>Spend by job</h3>
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th>Job</th><th>Layer</th><th>Calls</th><th>Cost</th><th>Without Jev</th></tr></thead>
                <tbody>{(x.by_purpose ?? []).map((r: any) => (
                  <tr key={r.purpose + r.layer}><td>{r.purpose}</td><td>{r.layer}</td><td>{r.calls}</td><td>{usd(r.cost, 4)}</td><td>{usd(r.baseline, 4)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <h3 style={{ marginTop: 16 }}>By model</h3>
            <div className="row wrap">{(x.by_model ?? []).map((r: any) => <span key={r.model} className="chip">{MODEL_NAMES[r.model] ?? r.model}: {r.calls} calls · {usd(r.cost, 3)}</span>)}</div>
          </div>
        </>
      )}

      <div className="card">
        <h2>Make invite codes</h2>
        <div className="row wrap">
          <input className="input" style={{ width: 90 }} type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          <input className="input grow" placeholder="Note, like Twitter batch 1" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary" onClick={make}>Create</button>
        </div>
        {codes.length > 0 && (
          <>
            <div className="row spread" style={{ marginTop: 12 }}><small>{codes.length} single use codes</small><button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(codes.map(link).join("\n"))}>Copy invite links</button></div>
            <pre className="mono" style={{ whiteSpace: "pre-wrap", background: "var(--surface-2)", padding: 10, borderRadius: 10 }}>{codes.join("\n")}</pre>
          </>
        )}
      </div>

      <div className="card">
        <h2>Waitlist</h2>
        {wait.loading ? <Loading /> : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Who</th><th>Wants help with</th><th>Joined</th><th></th></tr></thead>
              <tbody>{(wait.data ?? []).map((w) => {
                const code = invited[w.id] ?? w.invite_code;
                return (
                  <tr key={w.id}>
                    <td><div>{w.name ?? "·"}</div><small>{w.email}</small></td>
                    <td style={{ maxWidth: 320 }}>{w.why}</td>
                    <td><small>{ago(w.created_at)}</small></td>
                    <td>{code ? <a className="btn sm" href={mailto(w.email, w.name, code)}>Email invite ({code})</a> : <button className="btn sm primary" onClick={() => invite(w)}>Invite</button>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Users</h2>
        <p className="muted">Gmail only works for people you add as test users in Google Cloud (max 100) until Google verification passes. Give them a slot here after you add their email there.</p>
        {users.loading ? <Loading /> : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>User</th><th>Beta</th><th>Google</th><th>Msgs 30d</th><th>Cost 30d</th><th></th></tr></thead>
              <tbody>{(users.data ?? []).map((u) => (
                <tr key={u.id}>
                  <td><div>{u.display_name}</div><small>{u.email}</small></td>
                  <td>{u.beta_access ? <span className="chip good">in</span> : <span className="chip">no code</span>}</td>
                  <td>{u.google_connected ? <span className="chip good">connected</span> : u.google_slot ? <span className="chip gold">slot</span> : <span className="chip">none</span>}</td>
                  <td>{u.messages_30d}</td>
                  <td>{usd(u.cost_30d, 3)}</td>
                  <td>{u.google_slot ? <button className="btn ghost sm" onClick={() => slot(u, false)}>Remove slot</button> : <button className="btn sm" onClick={() => slot(u, true)}>Give Gmail slot</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ l, v, s }: { l: string; v: React.ReactNode; s?: string }) {
  return <div className="card stat"><div className="l">{l}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>;
}
