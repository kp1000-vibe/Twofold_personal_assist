import type { CapacitorConfig } from "@capacitor/cli";

// The bundle id is permanent once the app is in the stores. Change it before the first store upload
// if you buy a domain (for example app.twofold.family for twofold.family).
const config: CapacitorConfig = {
  appId: "com.twofold.family",
  appName: "Twofold",
  webDir: "dist",
  backgroundColor: "#f5f3ee",
  ios: { contentInset: "never", scheme: "Twofold" },
  android: { allowMixedContent: false },
  plugins: {
    SplashScreen: { launchShowDuration: 600, backgroundColor: "#1f2a44", showSpinner: false },
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};

export default config;
