import { useState } from "react";
import { ErrorBox, fn, Loading, must, Profile, supabase, useLoad, usd } from "../lib";

type Usage = { plan: string; plan_name: string; is_admin: boolean; budget: number; spent: number; resets: string; automations: number; max_automations: number; texts_today: number; text_daily_cap: number };
type Plan = { id: string; name: string; price_usd: number; monthly_ai_budget_usd: number; max_automations: number; text_daily_cap: number; sort: number };

export default function PlanCard({ profile }: { profile: Profile }) {
  const usage = useLoad(async () => must(await supabase.rpc("my_usage")) as Usage);
  const plans = useLoad(async () => must(await supabase.from("plans").select("*").order("sort")) as Plan[]);
  const asked = useLoad(async () => must(await supabase.from("upgrade_requests").select("plan")) as { plan: string }[]);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const u = usage.data;
  const pct = u ? Math.min(100, Math.round((Number(u.spent) / Math.max(Number(u.budget), 0.01)) * 100)) : 0;
  const want = async (plan: string) => {
    setErr(null);
    const { error } = await supabase.from("upgrade_requests").insert({ user_id: profile.id, plan });
    if (error && !error.message.includes("duplicate")) return setErr(error.message);
    asked.reload();
  };
  const del = async () => {
    setDeleting(true); setErr(null);
    try {
      await fn("account", { op: "delete", confirm });
      await supabase.auth.signOut();
      window.location.hash = "#/";
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setDeleting(false); }
  };
  const resets = u ? new Date(`${u.resets}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

  return (
    <>
      <div className="card">
        <h2>Plan and usage</h2>
        {usage.loading || !u ? <Loading /> : (
          <>
            <div className="row spread wrap">
              <div><strong>{u.plan_name}</strong>{u.is_admin && <span className="chip gold" style={{ marginLeft: 8 }}>admin, no limits</span>}</div>
              <small className="muted">Resets {resets}</small>
            </div>
            <div style={{ margin: "10px 0 4px", height: 8, borderRadius: 8, background: "var(--surface-2)", overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? "var(--bad)" : pct >= 80 ? "var(--warn)" : "var(--gold)" }} />
            </div>
            <div className="row spread wrap"><small>{pct}% of this month's AI allowance used</small><small className="muted">{usd(Number(u.spent), 2)} of {usd(Number(u.budget), 2)}</small></div>
            <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
              <span className="chip">Automations {u.automations} of {u.max_automations}</span>
              <span className="chip">Texts today {u.texts_today} of {u.text_daily_cap}</span>
            </div>
            {pct >= 100 && <div className="notice" style={{ marginTop: 10 }}>You are past your allowance, so Twofold is using its lighter model with no web search until {resets}.</div>}
          </>
        )}

        {plans.data && (
          <div className="grid cols-3" style={{ marginTop: 14 }}>
            {plans.data.map((p) => {
              const current = u?.plan === p.id;
              const requested = asked.data?.some((a) => a.plan === p.id);
              return (
                <div key={p.id} className="card" style={{ margin: 0, outline: current ? "2px solid var(--gold)" : undefined }}>
                  <div className="row spread"><strong>{p.name}</strong><span>{p.price_usd > 0 ? `$${p.price_usd}/mo` : "Free"}</span></div>
                  <ul className="ink2" style={{ paddingLeft: 18, margin: "8px 0" }}>
                    <li>{p.id === "free" ? "Everyday chat, drafts and reminders" : p.id === "plus" ? "About 6x the AI of Free" : "About 20x the AI of Free"}</li>
                    <li>{p.max_automations} automations</li>
                    <li>{p.text_daily_cap} texts a day</li>
                  </ul>
                  {current ? <span className="chip good">Your plan</span> : p.price_usd > 0 && (
                    requested ? <span className="chip">You are on the list</span> : <button className="btn sm primary" onClick={() => want(p.id)}>I want {p.name}</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <small className="muted" style={{ display: "block", marginTop: 8 }}>Paid plans open soon. Tap the one you want and you will get first access and a founder price.</small>
        <ErrorBox msg={err} />
      </div>

      <div className="card">
        <h2>Your data</h2>
        <p className="ink2" style={{ marginTop: 0 }}>Read how Twofold handles your data in the <a href="#/privacy">privacy policy</a>. Deleting your account removes your memories, messages, tasks, files and Google connection for good.</p>
        <div className="row wrap">
          <input className="input" style={{ width: 200 }} placeholder="Type DELETE" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          <button className="btn ghost danger" disabled={confirm !== "DELETE" || deleting} onClick={del}>{deleting ? "Deleting" : "Delete my account"}</button>
        </div>
      </div>
    </>
  );
}
