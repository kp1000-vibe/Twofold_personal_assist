// Text channels: iMessage (Sendblue), SMS for Android (Twilio, or Sendblue fallback) and WhatsApp (Twilio).
// Keys live only in edge function secrets. A channel with no keys simply reports itself as unavailable.
import { admin, clip, Profile, secret } from "./util.ts";

export type Kind = "imessage" | "sms" | "whatsapp";
export type Provider = "twilio" | "sendblue";

const env = (k: string) => Deno.env.get(k) ?? "";
const TW_SID = () => env("TWILIO_ACCOUNT_SID");
const TW_TOKEN = () => env("TWILIO_AUTH_TOKEN");
const TW_VERIFY = () => env("TWILIO_VERIFY_SID");
const TW_SMS_FROM = () => env("TWILIO_FROM"); // +1... number or MG... messaging service sid
const TW_WA_FROM = () => env("TWILIO_WHATSAPP_FROM"); // +1... WhatsApp enabled sender
const SB_KEY = () => env("SENDBLUE_API_KEY");
const SB_SECRET = () => env("SENDBLUE_API_SECRET");
const SB_FROM = () => env("SENDBLUE_FROM");

const twilioReady = () => !!(TW_SID() && TW_TOKEN());
const sendblueReady = () => !!(SB_KEY() && SB_SECRET() && SB_FROM());

export function providerFor(kind: Kind): Provider | null {
  if (kind === "imessage") return sendblueReady() ? "sendblue" : null;
  if (kind === "whatsapp") return twilioReady() && TW_WA_FROM() ? "twilio" : null;
  if (twilioReady() && TW_SMS_FROM()) return "twilio";
  return sendblueReady() ? "sendblue" : null; // Sendblue lines fall back to SMS for Android phones
}

/** What the Settings page shows: which channels work and which number to text. */
export function channelConfig() {
  const num = (k: Kind) => {
    const p = providerFor(k);
    if (!p) return null;
    if (k === "whatsapp") return TW_WA_FROM();
    if (p === "sendblue") return SB_FROM();
    return TW_SMS_FROM().startsWith("+") ? TW_SMS_FROM() : null;
  };
  return {
    imessage: { available: !!providerFor("imessage"), number: num("imessage") },
    sms: { available: !!providerFor("sms"), number: num("sms") },
    whatsapp: { available: !!providerFor("whatsapp"), number: num("whatsapp") },
  };
}

export function normalizePhone(raw: string): string | null {
  let s = String(raw ?? "").replace(/^whatsapp:/, "").replace(/[\s().-]/g, "");
  if (/^\d{10}$/.test(s)) s = `+1${s}`;
  if (/^1\d{10}$/.test(s)) s = `+${s}`;
  if (/^00\d+$/.test(s)) s = `+${s.slice(2)}`;
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

export async function whatsappAllowed(phone: string): Promise<boolean> {
  const { data } = await admin().from("app_settings").select("whatsapp_countries").eq("id", 1).single();
  const codes: string[] = data?.whatsapp_countries ?? [];
  const digits = phone.slice(1);
  return codes.some((c) => digits.startsWith(c));
}

// ---------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------
const twAuth = () => "Basic " + btoa(`${TW_SID()}:${TW_TOKEN()}`);

async function twilioSend(to: string, body: string, whatsapp: boolean) {
  const form = new URLSearchParams({ To: whatsapp ? `whatsapp:${to}` : to, Body: body });
  if (whatsapp) form.set("From", `whatsapp:${TW_WA_FROM()}`);
  else if (TW_SMS_FROM().startsWith("MG")) form.set("MessagingServiceSid", TW_SMS_FROM());
  else form.set("From", TW_SMS_FROM());
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW_SID()}/Messages.json`, {
    method: "POST", headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" }, body: form,
  });
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${clip(await r.text(), 300)}`);
}

async function sendblueSend(to: string, body: string) {
  const r = await fetch("https://api.sendblue.co/api/send-message", {
    method: "POST",
    headers: { "sb-api-key-id": SB_KEY(), "sb-api-secret-key": SB_SECRET(), "Content-Type": "application/json" },
    body: JSON.stringify({ number: to, from_number: SB_FROM(), content: body }),
  });
  if (!r.ok) throw new Error(`Sendblue ${r.status}: ${clip(await r.text(), 300)}`);
}

export async function typing(provider: Provider, to: string) {
  if (provider !== "sendblue") return;
  try {
    await fetch("https://api.sendblue.co/api/send-typing-indicator", {
      method: "POST",
      headers: { "sb-api-key-id": SB_KEY(), "sb-api-secret-key": SB_SECRET(), "Content-Type": "application/json" },
      body: JSON.stringify({ number: to, from_number: SB_FROM() }),
    });
  } catch { /* cosmetic only */ }
}

/** Split long replies at paragraph or sentence breaks so each piece stays readable. */
export function chunks(text: string, max = 1400): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(". ", max) + 1;
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.slice(0, 4);
}

export async function sendText(kind: Kind, to: string, text: string, provider?: Provider | null) {
  const p = provider ?? providerFor(kind);
  if (!p) throw new Error(`${kind} is not set up yet`);
  for (const part of chunks(text)) {
    if (p === "sendblue") await sendblueSend(to, part);
    else await twilioSend(to, part, kind === "whatsapp");
  }
}

/** Markdown from the agent turned into something that reads well in a text bubble. */
export function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*/g, ""))
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|\s)\*(\S[^*]*?)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^\|.*\|$/gm, (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter((c) => c && !/^:?-+:?$/.test(c)).join(" · "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Texts the user on their preferred linked channel (iMessage, then SMS, then WhatsApp).
 * WhatsApp only allows free form messages within 24 hours of their last message, so it is skipped otherwise.
 */
export async function textUser(userId: string, text: string) {
  const { data: rows } = await admin().from("channels").select("*").eq("user_id", userId).eq("notify", true);
  const order: Kind[] = ["imessage", "sms", "whatsapp"];
  const list = (rows ?? []).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const ch of list) {
    if (!providerFor(ch.kind)) continue;
    if (ch.kind === "whatsapp" && (!ch.last_inbound_at || Date.now() - new Date(ch.last_inbound_at).getTime() > 23.5 * 3600_000)) continue;
    try {
      await sendText(ch.kind, ch.phone, text);
      return true;
    } catch (e) {
      console.error("textUser", ch.kind, e);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// one time codes
// ---------------------------------------------------------------------------
async function sha(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Twilio Verify handles SMS and WhatsApp codes (already carrier registered). iMessage codes go out through Sendblue. */
export async function startOtp(userId: string, kind: Kind, phone: string) {
  const db = admin();
  const useVerify = kind !== "imessage" && twilioReady() && !!TW_VERIFY();
  if (useVerify) {
    const r = await fetch(`https://verify.twilio.com/v2/Services/${TW_VERIFY()}/Verifications`, {
      method: "POST", headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: phone, Channel: kind === "whatsapp" ? "whatsapp" : "sms" }),
    });
    if (!r.ok) throw new Error(`Could not send the code (${r.status}). Check the number and try again.`);
    await db.from("phone_otps").insert({ user_id: userId, kind, phone, code_hash: null, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    return;
  }
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const pepper = await secret("twofold_token_key");
  await db.from("phone_otps").insert({ user_id: userId, kind, phone, code_hash: await sha(`${pepper}:${phone}:${code}`), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  await sendText(kind, phone, `${code} is your Twofold code. It expires in 10 minutes. If you did not ask for this, ignore it.`);
}

export async function checkOtp(userId: string, kind: Kind, phone: string, code: string): Promise<boolean> {
  const db = admin();
  const { data: row } = await db.from("phone_otps").select("*").eq("user_id", userId).eq("kind", kind).eq("phone", phone)
    .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!row) throw new Error("That code expired. Send a new one.");
  if (row.attempts >= 5) throw new Error("Too many tries. Send a new code.");
  await db.from("phone_otps").update({ attempts: row.attempts + 1 }).eq("id", row.id);
  let ok = false;
  if (row.code_hash === null) {
    const r = await fetch(`https://verify.twilio.com/v2/Services/${TW_VERIFY()}/VerificationCheck`, {
      method: "POST", headers: { Authorization: twAuth(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: phone, Code: code }),
    });
    ok = r.ok && (await r.json()).status === "approved";
  } else {
    const pepper = await secret("twofold_token_key");
    ok = row.code_hash === (await sha(`${pepper}:${phone}:${code}`));
  }
  if (ok) await db.from("phone_otps").delete().eq("user_id", userId).eq("phone", phone);
  return ok;
}

// ---------------------------------------------------------------------------
// webhook checks
// ---------------------------------------------------------------------------
/** Twilio signs every webhook with the auth token: HMAC SHA1 over the public URL plus sorted form fields. */
export async function twilioSignatureOk(req: Request, params: Record<string, string>): Promise<boolean> {
  const sig = req.headers.get("x-twilio-signature");
  if (!sig || !TW_TOKEN()) return false;
  const { data } = await admin().from("app_settings").select("project_url").eq("id", 1).single();
  const u = new URL(req.url);
  const url = `${data?.project_url}/functions/v1/api/${u.pathname.split("/").filter(Boolean).pop()}${u.search}`;
  const payload = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(TW_TOKEN()), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const expect = btoa(String.fromCharCode(...mac));
  return sameText(expect, sig);
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function webhookKeyOk(req: Request): Promise<boolean> {
  const k = new URL(req.url).searchParams.get("k") ?? req.headers.get("sb-signing-secret") ?? "";
  return !!k && sameText(k, await secret("twofold_webhook_key"));
}

/** Download a media file from the provider and keep it in the user's private uploads folder. */
export async function saveMedia(profile: Profile, url: string, mime: string, provider: Provider) {
  const headers: Record<string, string> = provider === "twilio" ? { Authorization: twAuth() } : {};
  const r = await fetch(url, { headers, redirect: "follow" });
  if (!r.ok) return null;
  const type = (r.headers.get("content-type") ?? mime ?? "").split(";")[0];
  if (!(type.startsWith("image/") || type === "application/pdf")) return null;
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) return null;
  const ext = type === "application/pdf" ? "pdf" : type.split("/")[1]?.replace("jpeg", "jpg") ?? "img";
  const name = `text-${Date.now()}.${ext}`;
  const path = `${profile.id}/${crypto.randomUUID()}-${name}`;
  const { error } = await admin().storage.from("uploads").upload(path, buf, { contentType: type });
  if (error) return null;
  return { path, name, mime: type };
}
