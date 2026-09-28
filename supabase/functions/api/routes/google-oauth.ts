// POST (signed in): returns the Google consent URL.
// GET (Google redirect): exchanges the code, stores encrypted tokens, sends the user back to the app.
import { admin, handle, HttpError, json, requireUser } from "../shared/util.ts";
import { encrypt, exchangeCode, GOOGLE_SCOPES, redirectUri } from "../shared/google.ts";

async function appUrl(): Promise<string> {
  const { data } = await admin().from("app_settings").select("app_url").eq("id", 1).single();
  return (data?.app_url ?? "").replace(/\/$/, "") || "/";
}

export default handle(async (req) => {
  if (req.method === "POST") {
    const profile = await requireUser(req);
    if (!profile.google_slot) {
      throw new HttpError(403, "Google connect is limited to 100 beta testers until Google finishes reviewing the app. You are on the list.");
    }
    if (!Deno.env.get("GOOGLE_CLIENT_ID")) throw new HttpError(500, "Google is not configured yet");
    const state = crypto.randomUUID();
    await admin().from("oauth_states").insert({ state, user_id: profile.id });
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: GOOGLE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      ...(profile.email ? { login_hint: profile.email } : {}),
    });
    return json({ url });
  }

  const u = new URL(req.url);
  const back = await appUrl();
  const fail = (msg: string) => Response.redirect(`${back}/#/settings?google=error&msg=${encodeURIComponent(msg)}`, 302);
  if (u.searchParams.get("error")) return fail(u.searchParams.get("error")!);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code || !state) return fail("missing code");

  const db = admin();
  const { data: st } = await db.from("oauth_states").select("*").eq("state", state).maybeSingle();
  if (!st) return fail("link expired, try again");
  await db.from("oauth_states").delete().eq("state", state);
  if (Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return fail("link expired, try again");

  try {
    const tok = await exchangeCode(code);
    const needed = ["gmail.readonly", "gmail.send", "calendar.events"];
    const missing = needed.filter((s) => !tok.scope.includes(s));
    let email: string | null = null;
    if (tok.id_token) {
      const payload = JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      email = payload.email ?? null;
    }
    const { data: existing } = await db.from("google_accounts").select("refresh_token_enc").eq("user_id", st.user_id).maybeSingle();
    const refresh = tok.refresh_token ? await encrypt(tok.refresh_token) : existing?.refresh_token_enc;
    if (!refresh) return fail("Google did not return offline access, remove the app in your Google account and connect again");
    await db.from("google_accounts").upsert({
      user_id: st.user_id,
      google_email: email,
      refresh_token_enc: refresh,
      access_token_enc: await encrypt(tok.access_token),
      token_expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      scopes: tok.scope,
    });
    const note = missing.length ? `&missing=${encodeURIComponent(missing.join(","))}` : "";
    return Response.redirect(`${back}/#/settings?google=connected${note}`, 302);
  } catch (e) {
    console.error(e);
    return fail(e instanceof Error ? e.message : "connect failed");
  }
});
