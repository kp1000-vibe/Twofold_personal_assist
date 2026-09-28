// Plans and budgets. Each plan has a monthly AI budget. Past 100% the assistant drops to the cheap model
// without web search or background jobs; past 150% it pauses until the month resets or the user upgrades.
import { admin, Profile } from "./util.ts";

export type Budget = {
  plan: string; name: string; budget: number; spent: number; level: "ok" | "lite" | "blocked";
  maxAutomations: number; textDailyCap: number; resets: string;
};

export async function budgetFor(profile: Profile): Promise<Budget> {
  const db = admin();
  const planId = (profile as any).plan ?? "free";
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const resets = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const [{ data: plan }, { data: calls }] = await Promise.all([
    db.from("plans").select("*").eq("id", planId).single(),
    db.from("ai_calls").select("cost_usd").eq("user_id", profile.id).gte("created_at", monthStart.toISOString()),
  ]);
  const budget = Number(plan?.monthly_ai_budget_usd ?? 1);
  const spent = (calls ?? []).reduce((n, c) => n + Number(c.cost_usd ?? 0), 0);
  const ratio = spent / Math.max(budget, 0.01);
  const level = profile.is_admin ? "ok" : ratio >= 1.5 ? "blocked" : ratio >= 1 ? "lite" : "ok";
  return {
    plan: planId, name: plan?.name ?? "Free", budget, spent, level, resets,
    maxAutomations: profile.is_admin ? 1000 : plan?.max_automations ?? 2,
    textDailyCap: profile.is_admin ? 1000 : plan?.text_daily_cap ?? 20,
  };
}

export function blockedMessage(b: Budget, appUrl = "") {
  const when = new Date(`${b.resets}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `You have used this month's AI allowance on the ${b.name} plan. It resets ${when}.${b.plan === "free" ? ` Plus gives you about 6 times more.${appUrl ? ` ${appUrl}/#/settings` : " See Settings."}` : ""}`;
}

export async function markActive(userId: string, surface: string) {
  const { error } = await admin().rpc("mark_active", { p_user: userId, p_surface: surface });
  if (error) console.error("mark_active", error.message);
}
