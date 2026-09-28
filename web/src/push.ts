import { supabase } from "./lib";

function b64ToBytes(b64: string) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
}

export async function registerSW() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/** Ask permission, subscribe this device, and save it for the signed in user. */
export async function enablePush(userId: string): Promise<string | null> {
  if (!pushSupported()) return "This browser cannot show notifications. On iPhone, add Twofold to your Home Screen first.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Notifications are blocked in your browser settings.";
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSW());
  if (!reg) return "Could not start the notification service.";
  const { data } = await supabase.from("app_settings").select("vapid_public").eq("id", 1).single();
  if (!data?.vapid_public) return "Notifications are not configured yet.";
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.vapid_public) }));
  const j = sub.toJSON();
  const { error } = await supabase.from("push_subscriptions").upsert({ user_id: userId, endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth }, { onConflict: "endpoint" });
  return error ? error.message : null;
}

export async function pushEnabledHere() {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}
