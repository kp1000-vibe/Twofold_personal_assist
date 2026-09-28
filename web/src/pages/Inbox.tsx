import { useState } from "react";
import { Empty, ErrorBox, fn, go, Loading, must, Profile, supabase, useLoad, when } from "../lib";

type Email = { id: string; gmail_id: string; from_name: string; from_email: string; subject: string; snippet: string; received_at: string; category: string | null; urgency: number | null; needs_reply: number | null; injection_risk: number | null; status: string };

const LOW = ["newsletter", "promotion", "notification", "suspicious"];
const CAT_LABEL: Record<string, string> = {
  personal: "personal", work: "work", bills_finance: "bills", travel: "travel", orders: "orders", events: "events",
  newsletter: "newsletter", promotion: "promo", notification: "alert", suspicious: "suspicious",
};

export default function Inbox({ profile }: { profile: Profile }) {
  const status = useLoad(async () => must(await supabase.rpc("my_google_status")) as any);
  const emails = useLoad(async () => must(await supabase.from("emails").select("id, gmail_id, from_name, from_email, subject, snippet, received_at, category, urgency, needs_reply, injection_risk, status").eq("direction", "in").neq("status", "archived").order("received_at", { ascending: false }).limit(150)) as Email[]);
  const [tab, setTab] = useState<"needs" | "all" | "low">("needs");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sync = async () => {
    setBusy(true);
    setErr(null);
    try {
      await fn("sync-inbox");
      await emails.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const markDone = async (e: Email) => {
    await supabase.from("emails").update({ status: "handled" }).eq("id", e.id);
    emails.reload();
  };

  if (status.loading) return <Loading />;
  if (!status.data?.connected) {
    return (
      <div>
        <div className="page-head"><div><h1>Inbox</h1></div></div>
        <div className="card">
          <Empty title="Connect Gmail to turn this on">
            <p>Twofold sorts every new email, drafts replies for your OK, and spots bills and dates.</p>
            <button className="btn primary" onClick={() => go("settings")}>Go to Settings</button>
          </Empty>
        </div>
      </div>
    );
  }

  const all = (emails.data ?? []);
  const needs = all.filter((e) => e.status === "new" && !LOW.includes(e.category ?? "") && ((e.urgency ?? 0) >= 1.5 || (e.needs_reply ?? 0) > 0.8));
  const low = all.filter((e) => LOW.includes(e.category ?? ""));
  const shown = tab === "needs" ? needs : tab === "low" ? low : all;

  return (
    <div>
      <div className="page-head">
        <div><h1>Inbox</h1><p>{status.data.email} · sorted {all.length} recent emails</p></div>
        <button className="btn" onClick={sync} disabled={busy}>{busy ? "Syncing" : "Sync now"}</button>
      </div>
      <ErrorBox msg={err} />
      <div className="row" style={{ marginBottom: 12 }}>
        <button className={`btn sm ${tab === "needs" ? "primary" : ""}`} onClick={() => setTab("needs")}>Needs you ({needs.length})</button>
        <button className={`btn sm ${tab === "all" ? "primary" : ""}`} onClick={() => setTab("all")}>All</button>
        <button className={`btn sm ${tab === "low" ? "primary" : ""}`} onClick={() => setTab("low")}>Low priority ({low.length})</button>
      </div>
      <div className="card" style={{ padding: "4px 14px" }}>
        {emails.loading ? <Loading /> : shown.length === 0 ? <Empty title={tab === "needs" ? "Inbox zero, in spirit" : "Nothing here"} /> : shown.map((e) => (
          <div key={e.id} className="item" style={{ opacity: e.status === "handled" ? 0.55 : 1 }}>
            <span className="dot" style={{ marginTop: 8, background: urgencyColor(e.urgency) }} title={`urgency ${e.urgency ?? "?"} of 3`} />
            <div className="grow">
              <div className="row spread">
                <div className="title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.from_name || e.from_email}</div>
                <small>{when(e.received_at, profile.timezone)}</small>
              </div>
              <div>{e.subject}</div>
              <div className="sub" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.snippet}</div>
              <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
                {e.category && <span className={`chip ${e.category === "suspicious" ? "bad" : ""}`}>{CAT_LABEL[e.category] ?? e.category}</span>}
                {(e.needs_reply ?? 0) > 0.8 && <span className="chip gold">expects reply</span>}
                {(e.injection_risk ?? 0) > 0.7 && <span className="chip bad">has hidden AI instructions</span>}
                <span className="grow" />
                <button className="btn ghost sm" onClick={() => go(`chat?q=${encodeURIComponent(`Help me reply to the email from ${e.from_name || e.from_email} about "${e.subject}" (email id ${e.gmail_id})`)}`)}>Ask Twofold</button>
                {e.status !== "handled" && <button className="btn ghost sm" onClick={() => markDone(e)}>Done</button>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function urgencyColor(u: number | null) {
  if (u == null) return "var(--line)";
  if (u >= 2) return "var(--bad)";
  if (u >= 1.2) return "var(--gold)";
  return "var(--line)";
}
