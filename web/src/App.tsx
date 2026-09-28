import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { go, Icon, Loading, Logo, Profile, readHash, supabase } from "./lib";
import Landing from "./pages/Landing";
import Auth from "./pages/Auth";
import Gate from "./pages/Gate";
import Chat from "./pages/Chat";
import Today from "./pages/Today";
import Approvals from "./pages/Approvals";
import Tasks from "./pages/Tasks";
import Inbox from "./pages/Inbox";
import Money from "./pages/Money";
import Memory from "./pages/Memory";
import Settings from "./pages/Settings";
import Admin from "./pages/Admin";
import Activity from "./pages/Activity";
import Rules from "./pages/Rules";
import People from "./pages/People";
import Goals from "./pages/Goals";

const NAV = [
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "today", label: "Today", icon: "today" },
  { id: "approvals", label: "Approvals", icon: "approvals" },
  { id: "tasks", label: "Tasks", icon: "tasks" },
  { id: "goals", label: "Goals", icon: "goals" },
  { id: "people", label: "People", icon: "people" },
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "money", label: "Money", icon: "money" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "activity", label: "Activity", icon: "activity" },
  { id: "rules", label: "Rules", icon: "rules" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [route, setRoute] = useState(readHash());
  const [pending, setPending] = useState(0);
  const [recovery, setRecovery] = useState(false);

  // remember invite links like /?invite=CODE or #/?invite=CODE
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("invite") ?? readHash().params.get("invite");
    if (code) localStorage.setItem("twofold_invite", code.toUpperCase());
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadProfile = async () => {
    if (!session) return setProfile(null);
    const { data } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
    setProfile(data as Profile);
  };
  useEffect(() => { loadProfile(); }, [session?.user.id]);

  // live badge for approvals
  useEffect(() => {
    if (!profile?.beta_access) return;
    const count = async () => {
      const { count } = await supabase.from("actions").select("id", { count: "exact", head: true }).in("status", ["pending", "scheduled"]);
      setPending(count ?? 0);
    };
    count();
    const ch = supabase.channel("badge")
      .on("postgres_changes", { event: "*", schema: "public", table: "actions", filter: `user_id=eq.${profile.id}` }, count)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile?.id, profile?.beta_access]);

  if (session === undefined) return <Loading />;
  if (recovery && session) return <Auth mode="reset" onDone={() => { setRecovery(false); go("chat"); }} />;

  if (!session) {
    if (route.page === "signin" || route.page === "signup") return <Auth mode={route.page} />;
    return <Landing />;
  }
  if (!profile) return <Loading />;
  if (!profile.beta_access) return <Gate onJoined={loadProfile} />;

  const page = route.page && route.page !== "signin" && route.page !== "signup" ? route.page : "chat";
  const nav = profile.is_admin ? [...NAV, { id: "admin", label: "Admin", icon: "admin" }] : NAV;

  const body = (() => {
    switch (page) {
      case "today": return <Today profile={profile} />;
      case "approvals": return <Approvals profile={profile} />;
      case "tasks": return <Tasks profile={profile} />;
      case "inbox": return <Inbox profile={profile} />;
      case "money": return <Money />;
      case "goals": return <Goals profile={profile} />;
      case "people": return <People profile={profile} />;
      case "activity": return <Activity />;
      case "rules": return <Rules />;
      case "memory": return <Memory />;
      case "settings": return <Settings profile={profile} onSaved={loadProfile} params={route.params} />;
      case "admin": return profile.is_admin ? <Admin /> : <Chat profile={profile} />;
      default: return <Chat profile={profile} prefill={route.params.get("q") ?? undefined} />;
    }
  })();

  return (
    <div className="shell">
      <aside className="side">
        <Logo />
        {nav.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={`nav-item ${page === n.id ? "active" : ""}`}>
            <Icon name={n.icon} />
            {n.label}
            {n.id === "approvals" && pending > 0 && <span className="badge">{pending}</span>}
          </a>
        ))}
        <div className="foot">
          <div style={{ marginBottom: 6 }}>{profile.email}</div>
          <button className="btn sm" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </aside>
      <main className="main">{body}</main>
      <nav className="tabbar">
        {nav.filter((n) => ["chat", "today", "approvals", "tasks", "inbox", "settings"].includes(n.id)).map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={page === n.id ? "active" : ""}>
            <Icon name={n.icon} />
            {n.label}
            {n.id === "approvals" && pending > 0 && <span className="badge">{pending}</span>}
          </a>
        ))}
      </nav>
    </div>
  );
}
