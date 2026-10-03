// Link a phone number to Twofold after a one time code, for iMessage, Android SMS or WhatsApp.
import { admin, handle, HttpError, json, requireUser, secret } from "../shared/util.ts";
import { channelConfig, checkOtp, Kind, normalizePhone, providerFor, sendText, startOtp, whatsappAllowed } from "../shared/channels.ts";
import { logActivity } from "../shared/trust.ts";

const KINDS: Kind[] = ["imessage", "sms", "whatsapp"];
const LABEL: Record<Kind, string> = { imessage: "iMessage", sms: "SMS", whatsapp: "WhatsApp" };

export default handle(async (req) => {
  const profile = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const op = String(body.op ?? "config");
  const db = admin();

  if (op === "config") {
    const out: Record<string, unknown> = { channels: channelConfig() };
    if (profile.is_admin) {
      const { data } = await db.from("app_settings").select("project_url").eq("id", 1).single();
      const base = `${data?.project_url}/functions/v1/api`;
      out.webhooks = {
        twilio: `${base}/inbound-twilio`,
        sendblue: `${base}/inbound-sendblue?k=${await secret("twofold_webhook_key")}`,
        postmark: `${base}/inbound-email?k=${await secret("twofold_webhook_key")}`,
      };
    }
    return json(out);
  }

  const kind = String(body.kind) as Kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, "Pick iMessage, SMS or WhatsApp");
  const phone = normalizePhone(body.phone);
  if (!phone) throw new HttpError(400, "Enter the number with country code, like +1 510 555 0100");
  if (!providerFor(kind)) throw new HttpError(400, `${LABEL[kind]} is not switched on yet. It is coming soon.`);

  if (op === "start") {
    if (kind === "whatsapp" && !(await whatsappAllowed(phone))) {
      throw new HttpError(400, "WhatsApp does not allow AI assistants in your country yet (Meta rule). Use iMessage or SMS instead.");
    }
    const { data: taken } = await db.from("channels").select("user_id").eq("kind", kind).eq("phone", phone).maybeSingle();
    if (taken && taken.user_id !== profile.id) throw new HttpError(409, "That number is linked to another account");
    if (taken) throw new HttpError(409, "That number is already linked");
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const [{ count: mine }, { count: theirs }] = await Promise.all([
      db.from("phone_otps").select("id", { count: "exact", head: true }).eq("user_id", profile.id).gt("created_at", hourAgo),
      db.from("phone_otps").select("id", { count: "exact", head: true }).eq("phone", phone).gt("created_at", hourAgo),
    ]);
    if ((mine ?? 0) >= 5 || (theirs ?? 0) >= 3) throw new HttpError(429, "Too many codes. Wait an hour and try again.");
    try {
      await startOtp(profile.id, kind, phone);
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : "Could not send the code");
    }
    return json({ ok: true, phone });
  }

  if (op === "verify") {
    const code = String(body.code ?? "").replace(/\D/g, "");
    if (code.length < 4) throw new HttpError(400, "Enter the code you got");
    let ok = false;
    try {
      ok = await checkOtp(profile.id, kind, phone, code);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Could not check the code");
    }
    if (!ok) throw new HttpError(400, "That code is not right");
    const { error } = await db.from("channels").insert({ user_id: profile.id, kind, phone, last_inbound_at: null });
    if (error) throw new HttpError(409, "That number is already linked");
    await logActivity({ user_id: profile.id, kind: "channel_linked", title: `Linked ${LABEL[kind]} ${phone}`, why: "You verified the code" });
    const name = profile.display_name ? ` ${profile.display_name}` : "";
    await sendText(kind, phone, `Hi${name}, Twofold here 👋 You are linked. Text me anything: plans, reminders, "draft a reply to Sam", or a photo of a bill. I will ask before sending anything. Reply HELP anytime.`).catch((e) => console.error("welcome", e));
    return json({ ok: true });
  }

  throw new HttpError(400, "Unknown op");
});
