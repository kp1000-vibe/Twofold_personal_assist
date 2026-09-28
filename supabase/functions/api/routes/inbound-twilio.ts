// Twilio webhook for SMS and WhatsApp. Answers right away, then does the work in the background.
import { claimEvent, handleInbound } from "../shared/inbound.ts";
import { normalizePhone, twilioSignatureOk } from "../shared/channels.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
const EMPTY = new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>", { headers: { "Content-Type": "text/xml" } });

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("ok");
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => { params[k] = String(v); });
  if (!(await twilioSignatureOk(req, params))) return new Response("bad signature", { status: 403 });

  const whatsapp = (params.From ?? "").startsWith("whatsapp:");
  const phone = normalizePhone(params.From ?? "");
  if (!phone || !params.MessageSid) return EMPTY;
  const media = Array.from({ length: Math.min(Number(params.NumMedia ?? 0), 3) }, (_, i) => ({
    url: params[`MediaUrl${i}`], mime: params[`MediaContentType${i}`] ?? "",
  })).filter((m) => m.url);
  const ev = {
    provider: "twilio" as const, providerId: params.MessageSid, kinds: whatsapp ? ["whatsapp" as const] : ["sms" as const],
    phone, text: params.Body ?? "", media,
  };
  if (!(await claimEvent(ev))) return EMPTY;
  EdgeRuntime.waitUntil(handleInbound(ev).catch((e) => console.error("inbound twilio", e)));
  return EMPTY;
};
