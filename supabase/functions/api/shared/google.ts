import { admin, secret } from "./util.ts";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

// ---------------------------------------------------------------------------
// token encryption (AES GCM, key lives in Vault)
// ---------------------------------------------------------------------------
async function aesKey(): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(await secret("twofold_token_key")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plain)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}
export async function decrypt(enc: string): Promise<string> {
  const buf = Uint8Array.from(atob(enc), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, await aesKey(), buf.slice(12));
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------
export function redirectUri(): string {
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1/api/google-oauth`;
}

export async function exchangeCode(code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description ?? body.error ?? "Google token exchange failed");
  return body as { access_token: string; refresh_token?: string; expires_in: number; scope: string; id_token?: string };
}

export async function hasGoogle(userId: string): Promise<boolean> {
  const { data } = await admin().from("google_accounts").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}

/** A valid access token for this user, refreshing when needed. Null when not connected. */
export async function accessToken(userId: string): Promise<string | null> {
  const { data: acct } = await admin().from("google_accounts").select("*").eq("user_id", userId).maybeSingle();
  if (!acct || !acct.refresh_token_enc) return null;
  const exp = acct.token_expires_at ? new Date(acct.token_expires_at).getTime() : 0;
  if (acct.access_token_enc && exp - Date.now() > 60_000) return await decrypt(acct.access_token_enc);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: await decrypt(acct.refresh_token_enc),
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error("refresh failed", body);
    if (body.error === "invalid_grant") {
      // user revoked access in Google, drop the connection so the app shows reconnect
      await admin().from("google_accounts").delete().eq("user_id", userId);
    }
    return null;
  }
  await admin().from("google_accounts").update({
    access_token_enc: await encrypt(body.access_token),
    token_expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(),
  }).eq("user_id", userId);
  return body.access_token;
}

async function g(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `Google API ${res.status}`);
  return body;
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export async function gmailList(token: string, q: string, max = 20): Promise<{ id: string; threadId: string }[]> {
  const body = await g(token, `${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(max) })}`);
  return body.messages ?? [];
}

export type Mail = {
  id: string; threadId: string; from: string; fromName: string; fromEmail: string; to: string;
  subject: string; date: string; snippet: string; body: string; messageId: string; labels: string[];
  receivedAt: string;
};

export async function gmailGet(token: string, id: string, full = true): Promise<Mail> {
  const params = full ? "format=full" : "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID";
  const m = await g(token, `${GMAIL}/messages/${id}?${params}`);
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  const from = headers["from"] ?? "";
  const match = from.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  return {
    id: m.id,
    threadId: m.threadId,
    from,
    fromName: (match?.[1] ?? "").trim() || from,
    fromEmail: (match?.[2] ?? from).trim().toLowerCase(),
    to: headers["to"] ?? "",
    subject: headers["subject"] ?? "(no subject)",
    date: headers["date"] ?? "",
    snippet: decodeEntities(m.snippet ?? ""),
    body: full ? extractBody(m.payload).slice(0, 6000) : "",
    messageId: headers["message-id"] ?? "",
    labels: m.labelIds ?? [],
    receivedAt: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
  };
}

function b64url(s: string): string {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function extractBody(payload: any): string {
  if (!payload) return "";
  const walk = (p: any, mime: string): string | null => {
    if (p.mimeType === mime && p.body?.data) return b64url(p.body.data);
    for (const part of p.parts ?? []) {
      const hit = walk(part, mime);
      if (hit) return hit;
    }
    return null;
  };
  const plain = walk(payload, "text/plain");
  if (plain) return tidy(plain);
  const html = walk(payload, "text/html");
  if (html) return tidy(html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " "));
  if (payload.body?.data) return tidy(b64url(payload.body.data));
  return "";
}
function tidy(s: string) {
  return decodeEntities(s)
    .split("\n")
    .filter((l) => !l.trim().startsWith(">")) // drop quoted history
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function decodeEntities(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

function encodeHeader(v: string) {
  // RFC 2047 for non ascii subjects
  return /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(v)))}?=`;
}

export async function gmailSend(token: string, m: {
  to: string; subject: string; body: string; cc?: string; threadId?: string; inReplyTo?: string;
}) {
  const lines = [
    `To: ${m.to}`,
    ...(m.cc ? [`Cc: ${m.cc}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    m.body,
  ];
  const raw = btoa(unescape(encodeURIComponent(lines.join("\r\n")))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return await g(token, `${GMAIL}/messages/send`, {
    method: "POST",
    body: JSON.stringify({ raw, ...(m.threadId ? { threadId: m.threadId } : {}) }),
  });
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type CalEvent = { id: string; summary: string; start: string; end: string; location?: string; attendees?: string[]; allDay: boolean };

export async function calendarList(token: string, timeMin: string, timeMax: string, max = 25): Promise<CalEvent[]> {
  const body = await g(token, `${CAL}?${new URLSearchParams({
    timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: String(max),
  })}`);
  return (body.items ?? []).map((e: any) => ({
    id: e.id,
    summary: e.summary ?? "(busy)",
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    location: e.location,
    attendees: (e.attendees ?? []).map((a: any) => a.email),
    allDay: !e.start?.dateTime,
  }));
}

export async function calendarDelete(token: string, eventId: string) {
  return await g(token, `${CAL}/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" });
}

export async function calendarInsert(token: string, ev: {
  summary: string; start: string; end: string; timezone: string; location?: string; description?: string; attendees?: string[];
}) {
  return await g(token, `${CAL}?sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify({
      summary: ev.summary,
      location: ev.location,
      description: ev.description,
      start: { dateTime: ev.start, timeZone: ev.timezone },
      end: { dateTime: ev.end, timeZone: ev.timezone },
      attendees: (ev.attendees ?? []).map((email) => ({ email })),
    }),
  });
}
