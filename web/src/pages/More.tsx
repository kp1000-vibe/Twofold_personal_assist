import { Icon } from "../lib";

/** Everything that is not a main tab, in one tidy screen (mostly for phones). */
export default function More({ items }: { items: { id: string; label: string; icon: string }[] }) {
  const blurb: Record<string, string> = {
    tasks: "Todos, reminders and promises", goals: "Bigger plans with steps", people: "Birthdays and keeping in touch",
    decisions: "Your calls and how they turned out", inbox: "Mail sorted by what needs you", money: "Subscriptions and bills",
    memory: "What Twofold knows about you", activity: "What it did and why, with undo", rules: "What it may do without asking",
    settings: "Plan, texting, Google, alerts", admin: "Growth and costs",
  };
  return (
    <div>
      <div className="page-head"><div><h1>More</h1></div></div>
      <div className="grid cols-3">
        {items.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className="card" style={{ textDecoration: "none", margin: 0, display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ width: 22, height: 22, display: "inline-flex" }}><Icon name={n.icon} /></span>
            <div><strong>{n.label}</strong><div className="muted" style={{ fontSize: 13 }}>{blurb[n.id] ?? ""}</div></div>
          </a>
        ))}
      </div>
    </div>
  );
}
