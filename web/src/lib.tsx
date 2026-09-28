import { createClient } from "@supabase/supabase-js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useCallback, useEffect, useState } from "react";

export const APP_NAME = "Twofold";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_KEY as string;
export const supabase = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });

export type Profile = {
  id: string; email: string | null; display_name: string | null; timezone: string; brief_hour: number;
  remind_by_email: boolean; beta_access: boolean; is_admin: boolean; google_slot: boolean;
};

/** Call an edge function and surface its error message. */
export async function fn<T = any>(name: string, body?: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`api/${name}`, { body: body ?? {} });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.json === "function") msg = (await ctx.json()).error ?? msg;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return data as T;
}

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loader());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Throw on Supabase errors so useLoad can show them. */
export function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

export function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string, { ADD_ATTR: ["target"] });
  return <div className="md" dangerouslySetInnerHTML={{ __html: html.replace(/<a /g, '<a target="_blank" rel="noopener" ') }} />;
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <a className="logo" href="#/">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="8" fill="var(--accent)" />
        <circle cx="13" cy="16" r="7" fill="var(--gold)" />
        <circle cx="19" cy="16" r="7" fill="none" stroke="var(--accent-ink)" strokeWidth="2.4" />
      </svg>
      {APP_NAME}
    </a>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty"><div className="big">{title}</div>{children}</div>;
}

export function Loading() {
  return <div className="empty"><span className="thinking"><i /><i /> loading</span></div>;
}

export function ErrorBox({ msg }: { msg: string | null }) {
  return msg ? <div className="error">{msg}</div> : null;
}

export function when(iso: string | null | undefined, tz?: string, withTime = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, month: "short", day: "numeric" };
  if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleString("en-US", opts);
}

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function money(n: number | null | undefined, currency = "USD") {
  if (n == null) return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

export function usd(n: number, digits = 4) {
  return `$${Number(n || 0).toFixed(digits)}`;
}

export const MODEL_NAMES: Record<string, string> = {
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5-5": "Claude Opus 5.5",
};

/** Hash router helpers: #/page?x=1 */
export function readHash() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, q] = raw.split("?");
  return { page: path || "", params: new URLSearchParams(q ?? "") };
}
export function go(page: string) {
  window.location.hash = `#/${page}`;
}

export function toLocalInput(iso: string | null, tz: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}
/** A datetime local input value, read as wall time in tz, to a real instant. */
export function fromLocalInput(v: string, tz: string): string | null {
  if (!v) return null;
  const guess = new Date(`${v}:00Z`);
  const shown = new Date(new Date(guess).toLocaleString("en-US", { timeZone: tz }));
  const utcShown = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  const diff = shown.getTime() - utcShown.getTime();
  return new Date(guess.getTime() - diff).toISOString();
}

// minimal line icons
const P: Record<string, string> = {
  chat: "M4 5h16v11H8l-4 4z",
  today: "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 100 8 4 4 0 000-8z",
  approvals: "M9 12l2 2 4-4M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z",
  tasks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  inbox: "M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z",
  money: "M3 7h18v10H3zM7 12h.01M17 12h.01M12 10a2 2 0 100 4 2 2 0 000-4z",
  memory: "M12 4a5 5 0 00-5 5c0 2 1 3 2 4v3h6v-3c1-1 2-2 2-4a5 5 0 00-5-5zM10 20h4",
  settings: "M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-1-3-2 .3-1.4-1.4L17 5l-3-1-1 2h-2L10 4 7 5l.4 2-1.4 1.4L4 8l-1 3 2 1v0l-2 1 1 3 2-.3 1.4 1.4L7 19l3 1 1-2h2l1 2 3-1-.4-2 1.4-1.4 2 .4 1-3z",
  admin: "M4 20V10M10 20V4M16 20v-7M22 20H2",
};
export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={P[name] ?? ""} />
    </svg>
  );
}
