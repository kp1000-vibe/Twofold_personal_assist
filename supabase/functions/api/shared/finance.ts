// Life simulator. All arithmetic happens here in code, never inside a model.
export type SimInput = {
  monthly_net_income: number;
  monthly_spending: number;          // everything except housing
  current_rent?: number;             // housing cost today, replaced if buying
  cash_savings?: number;
  investments?: number;
  annual_return_pct?: number;
  years?: number;
  extra_monthly_costs?: number;      // childcare, car, new costs in both scenarios
  purchase?: {
    home_price: number;
    down_payment_pct?: number;
    mortgage_rate_pct?: number;
    term_years?: number;
    property_tax_pct?: number;
    insurance_monthly?: number;
    hoa_monthly?: number;
    maintenance_pct?: number;
    appreciation_pct?: number;
  };
};

function payment(principal: number, ratePct: number, years: number) {
  const r = ratePct / 100 / 12;
  const n = years * 12;
  return r === 0 ? principal / n : (principal * r) / (1 - Math.pow(1 + r, -n));
}

const round = (x: number) => Math.round(x);

export function simulate(inp: SimInput) {
  const years = Math.min(Math.max(inp.years ?? 10, 1), 40);
  const ret = (inp.annual_return_pct ?? 6) / 100 / 12;
  const extra = inp.extra_monthly_costs ?? 0;
  const rent = inp.current_rent ?? 0;
  const startInvest = (inp.cash_savings ?? 0) + (inp.investments ?? 0);

  // scenario A: keep things as they are
  let a = startInvest;
  const surplusA = inp.monthly_net_income - inp.monthly_spending - rent - extra;
  for (let m = 0; m < years * 12; m++) a = a * (1 + ret) + surplusA;

  const result: Record<string, unknown> = {
    years,
    assumptions: { annual_return_pct: inp.annual_return_pct ?? 6 },
    stay: { monthly_surplus: round(surplusA), invested_at_end: round(a) },
  };

  if (inp.purchase) {
    const p = inp.purchase;
    const downPct = p.down_payment_pct ?? 20;
    const down = p.home_price * downPct / 100;
    const closing = p.home_price * 0.025;
    const loan = p.home_price - down;
    const mortgage = payment(loan, p.mortgage_rate_pct ?? 6.5, p.term_years ?? 30);
    const tax = p.home_price * (p.property_tax_pct ?? 1.1) / 100 / 12;
    const maint = p.home_price * (p.maintenance_pct ?? 1) / 100 / 12;
    const housing = mortgage + tax + (p.insurance_monthly ?? 150) + (p.hoa_monthly ?? 0) + maint;
    const surplusB = inp.monthly_net_income - inp.monthly_spending - housing - extra;

    let b = startInvest - down - closing;
    let balance = loan;
    const r = (p.mortgage_rate_pct ?? 6.5) / 100 / 12;
    let lowest = b;
    for (let m = 0; m < years * 12; m++) {
      b = b * (1 + (b > 0 ? ret : 0)) + surplusB;
      lowest = Math.min(lowest, b);
      const interest = balance * r;
      balance = Math.max(0, balance - (mortgage - interest));
    }
    const value = p.home_price * Math.pow(1 + (p.appreciation_pct ?? 3) / 100, years);
    const equity = value - balance;
    const flags: string[] = [];
    if (startInvest < down + closing) flags.push(`Down payment and closing (${round(down + closing)}) is more than current savings (${round(startInvest)})`);
    if (surplusB < 0) flags.push(`Monthly budget goes negative by ${round(-surplusB)} after buying`);
    if (housing > inp.monthly_net_income * 0.36) flags.push(`Housing would be ${round(housing / inp.monthly_net_income * 100)} percent of take home pay (a common comfort limit is about 30 to 36)`);
    const emergencyMonths = (startInvest - down - closing) / Math.max(1, inp.monthly_spending + housing + extra);
    if (emergencyMonths < 3) flags.push(`Only about ${emergencyMonths.toFixed(1)} months of expenses left as a cushion after buying`);

    result.buy = {
      down_payment: round(down), closing_costs_est: round(closing), loan: round(loan),
      mortgage_payment: round(mortgage), total_monthly_housing: round(housing),
      monthly_surplus: round(surplusB), invested_at_end: round(b), lowest_invested_balance: round(lowest),
      home_value_at_end: round(value), mortgage_left_at_end: round(balance), home_equity_at_end: round(equity),
      net_worth_at_end: round(b + equity),
    };
    result.stay_net_worth_at_end = round(a);
    result.difference_in_investments = round(b - a);
    result.difference_in_net_worth = round(b + equity - a);
    result.flags = flags;
  }
  return result;
}
