import { useState } from "react";
import { ago, Empty, go, Loading, must, Profile, supabase, useLoad, when } from "../lib";

type Person = { id: string; name: string; relation: string | null; emails: string[]; birthday: string | null; notes: string | null; last_contact_at: string | null };

export default function People({ profile }: { profile: Profile }) {
  const people = useLoad(async () => must(await supabase.from("people").select("*").order("name")) as Person[]);
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    await supabase.from("people").insert({ user_id: profile.id, name: name.trim(), relation: relation.trim() || null });
    setName(""); setRelation("");
    people.reload();
  };

  const list = (people.data ?? []).filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || (p.relation ?? "").toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <div className="page-head"><div><h1>People</h1><p>Who matters to you: birthdays, history, promises. Grows from your chats and email.</p></div></div>
      <form className="card row wrap" onSubmit={add} style={{ marginBottom: 14 }}>
        <input className="input grow" style={{ minWidth: 160 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" style={{ flex: "0 1 200px" }} placeholder="Relation, like sister" value={relation} onChange={(e) => setRelation(e.target.value)} />
        <button className="btn primary">Add</button>
      </form>
      {(people.data ?? []).length > 6 && <input className="input" style={{ marginBottom: 10 }} placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} />}
      <div className="card" style={{ padding: "4px 14px" }}>
        {people.loading ? <Loading /> : list.length === 0 ? <Empty title="No people yet">Tell the chat things like "my sister Anya's birthday is March 3".</Empty> : list.map((p) => (
          <div key={p.id} className="item" style={{ display: "block" }}>
            <div className="row spread" style={{ cursor: "pointer" }} onClick={() => setOpen(open === p.id ? null : p.id)}>
              <div>
                <div className="title">{p.name} {p.relation && <span className="chip">{p.relation}</span>}</div>
                <div className="sub">{p.birthday ? `Birthday ${p.birthday} · ` : ""}{p.last_contact_at ? `Last email ${ago(p.last_contact_at)}` : "No email contact yet"}</div>
              </div>
              <small>{open === p.id ? "Hide" : "Open"}</small>
            </div>
            {open === p.id && <PersonDetail p={p} tz={profile.timezone} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function PersonDetail({ p, tz }: { p: Person; tz: string }) {
  const tasks = useLoad(async () => must(await supabase.from("tasks").select("id, title, kind, status, due_at").eq("person_id", p.id).order("created_at", { ascending: false }).limit(20)) as any[], [p.id]);
  const mails = useLoad(async () => p.emails.length ? must(await supabase.from("emails").select("id, subject, received_at, direction").or(p.emails.map((e) => `from_email.eq.${e}`).join(",")).order("received_at", { ascending: false }).limit(8)) as any[] : [], [p.id]);
  return (
    <div className="stack" style={{ marginTop: 10 }}>
      {p.emails.length > 0 && <div className="sub">Email: {p.emails.join(", ")}</div>}
      {p.notes && <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0, background: "var(--surface-2)", padding: 10, borderRadius: 10 }}>{p.notes}</pre>}
      {(tasks.data ?? []).length > 0 && (
        <div><strong>Promises and tasks</strong>{(tasks.data ?? []).map((t) => <div key={t.id} className="sub">{t.status === "done" ? "✓" : "·"} {t.title}{t.due_at ? ` (${when(t.due_at, tz)})` : ""}</div>)}</div>
      )}
      {(mails.data ?? []).length > 0 && (
        <div><strong>Recent emails</strong>{(mails.data ?? []).map((m) => <div key={m.id} className="sub">{when(m.received_at, tz, false)} · {m.subject}</div>)}</div>
      )}
      <div className="row wrap">
        <button className="btn sm" onClick={() => go(`chat?q=${encodeURIComponent(`Draft a short note to ${p.name}`)}`)}>Write to {p.name}</button>
        <button className="btn sm" onClick={() => go(`chat?q=${encodeURIComponent(`What do you know about ${p.name}?`)}`)}>What do I know</button>
      </div>
    </div>
  );
}
