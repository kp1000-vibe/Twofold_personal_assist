import { Empty, go, Loading, money, must, supabase, useLoad } from "../lib";

type Sub = { id: string; merchant: string; amount: number | null; currency: string; cadence: string; last_charged_at: string | null; next_expected_at: string | null; status: string };

export default function Money() {
  const subs = useLoad(async () => must(await supabase.from("subscriptions").select("*").neq("status", "ignored").order("amount", { ascending: false, nullsFirst: false })) as Sub[]);
  const list = subs.data ?? [];
  const monthly = list.filter((s) => s.status === "active" && s.amount != null && s.currency === "USD").reduce((sum, s) => {
    const a = Number(s.amount);
    return sum + (s.cadence === "yearly" ? a / 12 : s.cadence === "weekly" ? (a * 52) / 12 : s.cadence === "monthly" ? a : 0);
  }, 0);

  const ignore = async (s: Sub) => {
    await supabase.from("subscriptions").update({ status: "ignored" }).eq("id", s.id);
    subs.reload();
  };

  return (
    <div>
      <div className="page-head"><div><h1>Money</h1><p>Recurring charges found in your receipts.</p></div></div>
      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="l">Per month, about</div><div className="v">{money(monthly)}</div><div className="s">USD subscriptions</div></div>
        <div className="card stat"><div className="l">Per year, about</div><div className="v">{money(monthly * 12)}</div></div>
        <div className="card stat"><div className="l">Tracked</div><div className="v">{list.length}</div></div>
      </div>
      <div className="card" style={{ padding: "4px 14px" }}>
        {subs.loading ? <Loading /> : list.length === 0 ? (
          <Empty title="No subscriptions found yet">They appear as receipts arrive in your connected Gmail.</Empty>
        ) : list.map((s) => (
          <div key={s.id} className="item">
            <div className="grow">
              <div className="title">{s.merchant}</div>
              <div className="sub">
                {s.amount != null ? money(Number(s.amount), s.currency) : "amount unknown"} · {s.cadence}
                {s.next_expected_at && s.status === "active" && ` · next around ${s.next_expected_at}`}
              </div>
            </div>
            {s.status !== "active" ? <span className="chip warn">{s.status.replace("_", " ")}</span> : (
              <>
                <button className="btn sm" onClick={() => go(`chat?q=${encodeURIComponent(`Help me cancel my ${s.merchant} subscription (subscription id ${s.id})`)}`)}>Help me cancel</button>
                <button className="btn ghost sm" onClick={() => ignore(s)}>Hide</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
