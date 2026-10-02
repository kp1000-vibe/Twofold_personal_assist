// Native shell (iPhone and Android app via Capacitor). Everything here is a no op in the browser.
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { PushNotifications } from "@capacitor/push-notifications";
import { StatusBar, Style } from "@capacitor/status-bar";
import { SplashScreen } from "@capacitor/splash-screen";
import { supabase } from "./lib";

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as "ios" | "android" | "web";
/** Store builds set this once Firebase (Android) or APNs (iPhone) is configured; without it, registering would crash Android. */
export const nativePushConfigured = import.meta.env.VITE_NATIVE_PUSH === "1";

export async function initNative() {
  if (!isNative) return;
  document.documentElement.classList.add("native", `native-${platform}`);
  try { await StatusBar.setStyle({ style: Style.Light }); } catch { /* older devices */ }
  try { if (platform === "android") await StatusBar.setBackgroundColor({ color: "#f5f3ee" }); } catch { /* ignore */ }
  SplashScreen.hide().catch(() => {});
  // coming back to the app (for example after Google sign in in the browser) refreshes what is on screen
  App.addListener("resume", () => window.dispatchEvent(new Event("twofold:resume")));
  App.addListener("backButton", ({ canGoBack }) => { if (canGoBack) history.back(); else App.minimizeApp(); });
  // tapping a notification opens the page it points to
  PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
    const link = (a.notification.data?.link as string) || "#/home";
    window.location.hash = link.replace(/^#/, "");
  });
}

/** Open a page outside the app. Google blocks sign in inside embedded web views, so this uses the system browser. */
export async function openExternal(url: string) {
  if (isNative) await Browser.open({ url, presentationStyle: "popover" });
  else window.location.href = url;
}

/** Ask for notification permission and save this phone's push token. */
export async function enableNativePush(userId: string): Promise<string | null> {
  if (!nativePushConfigured) return "Notifications for the phone app are being set up. They will work in the next app update.";
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
  if (perm.receive !== "granted") return "Notifications are off for Twofold. Turn them on in your phone settings.";
  if (platform === "android") {
    await PushNotifications.createChannel({ id: "default", name: "Reminders and family", importance: 4, visibility: 1 }).catch(() => {});
  }
  const token = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), 15000);
    PushNotifications.addListener("registration", (r) => { clearTimeout(t); resolve(r.value); });
    PushNotifications.addListener("registrationError", (e) => { clearTimeout(t); reject(new Error(e.error)); });
    PushNotifications.register();
  }).catch((e) => { throw new Error(`Could not register this phone for notifications (${e.message}).`); });
  const { error } = await supabase.from("push_subscriptions").upsert(
    { user_id: userId, endpoint: `${platform === "ios" ? "apns" : "fcm"}:${token}`, platform, p256dh: null, auth: null }, { onConflict: "endpoint" });
  if (error) return error.message;
  localStorage.setItem("twofold_native_push", "1");
  return null;
}

export async function nativePushOn() {
  if (!isNative) return false;
  const perm = await PushNotifications.checkPermissions();
  return perm.receive === "granted" && localStorage.getItem("twofold_native_push") === "1";
}
