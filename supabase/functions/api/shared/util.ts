import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

let _admin: SupabaseClient | null = null;
export function admin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
  }
  return _admin;
}

export type Profile = {
  id: string;
  email: string | null;
  display_name: string | null;
  timezone: string;
  brief_hour: number;
  remind_by_email: boolean;
  beta_access: boolean;
  is_admin: boolean;
  google_slot: boolean;
};

/** Resolve the calling user from the Authorization header and require beta access. */
export async function requireUser(req: Request): Promise<Profile> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in first");
  const { data, error } = await admin().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Session expired, sign in again");
  const { data: profile } = await admin().from("profiles").select("*").eq("id", data.user.id).single();
  if (!profile) throw new HttpError(403, "No profile");
  if (!profile.beta_access) throw new HttpError(403, "You need an invite code to use Twofold");
  return profile as Profile;
}

const secretCache = new Map<string, string>();
export async function secret(name: string): Promise<string> {
  const hit = secretCache.get(name);
  if (hit) return hit;
  const { data, error } = await admin().rpc("svc_secret", { p_name: name });
  if (error || !data) throw new Error(`missing secret ${name}`);
  secretCache.set(name, data as string);
  return data as string;
}

/** Scheduled jobs send the shared secret stored in Vault. */
export async function isCron(req: Request): Promise<boolean> {
  const got = req.headers.get("x-cron-secret");
  if (!got) return false;
  return got === (await secret("twofold_cron_secret"));
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: e instanceof Error ? e.message : "Something went wrong" }, 500);
    }
  };
}

/** Local wall clock facts for a timezone, computed in code (never by a model). */
export function localNow(tz: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long", timeZoneName: "longOffset",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const offsetRaw = get("timeZoneName").replace("GMT", "") || "+00:00";
  const offset = offsetRaw === "" ? "+00:00" : offsetRaw;
  const hour = Number(get("hour")) % 24;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    date,
    hour,
    weekday: get("weekday"),
    offset,
    iso: `${date}T${String(hour).padStart(2, "0")}:${get("minute")}:00${offset}`,
    pretty: at.toLocaleString("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" }),
  };
}

export function clip(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
