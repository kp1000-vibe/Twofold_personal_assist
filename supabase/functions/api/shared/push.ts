// Web push to installed apps and browsers. Keys live in Vault and app_settings.
import webpush from "npm:web-push@3.6.7";
import { admin, secret } from "./util.ts";

let ready = false;
async function setup() {
  if (ready) return true;
  const { data } = await admin().from("app_settings").select("vapid_public, admin_emails").eq("id", 1).single();
  if (!data?.vapid_public) return false;
  const priv = await secret("twofold_vapid_private");
  webpush.setVapidDetails(`mailto:${data.admin_emails?.[0] ?? "admin@example.com"}`, data.vapid_public, priv);
  ready = true;
  return true;
}

export async function pushTo(userId: string, msg: { title: string; body?: string | null; link?: string }) {
  try {
    const { data: subs } = await admin().from("push_subscriptions").select("*").eq("user_id", userId);
    if (!subs?.length || !(await setup())) return 0;
    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: msg.title, body: msg.body ?? "", link: msg.link ?? "#/today" }),
          { TTL: 3600 },
        );
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await admin().from("push_subscriptions").delete().eq("id", s.id);
        } else console.error("push", e?.statusCode, e?.body ?? e);
      }
    }
    return sent;
  } catch (e) {
    console.error("push setup", e);
    return 0;
  }
}
