// Native phone push through Firebase Cloud Messaging (Android directly, iPhone through APNs in Firebase).
// Needs the edge function secret FCM_SERVICE_ACCOUNT: the Firebase service account JSON, pasted as is.

let cached: { token: string; exp: number; project: string } | null = null;

const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function fcmReady() {
  return !!Deno.env.get("FCM_SERVICE_ACCOUNT");
}

async function accessToken() {
  if (cached && cached.exp > Date.now() + 60_000) return cached;
  const sa = JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT")!);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const pem = String(sa.private_key).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`FCM auth ${res.status}: ${body.error_description ?? body.error}`);
  cached = { token: body.access_token, exp: Date.now() + body.expires_in * 1000, project: sa.project_id };
  return cached;
}

/** Returns "gone" when the device token is no longer valid and should be deleted. */
export async function sendFcm(deviceToken: string, msg: { title: string; body?: string | null; link?: string }): Promise<"ok" | "gone" | "error"> {
  const { token, project } = await accessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: msg.title, body: msg.body ?? "" },
        data: { link: msg.link ?? "#/home" },
        android: { priority: "high", notification: { channel_id: "default", color: "#1f2a44" } },
        apns: { payload: { aps: { sound: "default" } } },
      },
    }),
  });
  if (res.ok) return "ok";
  const text = await res.text();
  if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*token/i.test(text)) return "gone";
  console.error("fcm", res.status, text.slice(0, 300));
  return "error";
}

// ---------------------------------------------------------------------------
// iPhone: Capacitor gives an APNs device token, so iPhones are sent to Apple directly.
// Secrets: APNS_KEY_P8 (the .p8 file contents), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_SANDBOX=1 for dev builds.
let apnsJwt: { token: string; at: number } | null = null;

export function apnsReady() {
  return !!(Deno.env.get("APNS_KEY_P8") && Deno.env.get("APNS_KEY_ID") && Deno.env.get("APNS_TEAM_ID"));
}

async function apnsToken() {
  if (apnsJwt && Date.now() - apnsJwt.at < 40 * 60_000) return apnsJwt.token;
  const pem = Deno.env.get("APNS_KEY_P8")!.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: Deno.env.get("APNS_KEY_ID") }));
  const claims = b64url(JSON.stringify({ iss: Deno.env.get("APNS_TEAM_ID"), iat: Math.floor(Date.now() / 1000) }));
  // WebCrypto returns the raw r||s signature, which is exactly what ES256 JWTs use
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`)));
  apnsJwt = { token: `${header}.${claims}.${b64url(sig)}`, at: Date.now() };
  return apnsJwt.token;
}

export async function sendApns(deviceToken: string, msg: { title: string; body?: string | null; link?: string }): Promise<"ok" | "gone" | "error"> {
  const host = Deno.env.get("APNS_SANDBOX") === "1" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const res = await fetch(`https://${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await apnsToken()}`,
      "apns-topic": Deno.env.get("APNS_BUNDLE_ID") ?? "com.twofold.family",
      "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json",
    },
    body: JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body ?? "" }, sound: "default" }, link: msg.link ?? "#/home" }),
  });
  if (res.ok) return "ok";
  const text = await res.text();
  if (res.status === 410 || /BadDeviceToken|Unregistered/.test(text)) return "gone";
  console.error("apns", res.status, text.slice(0, 200));
  return "error";
}
