// Sendblue webhook for iMessage (and SMS fallback from Android phones on the same number).
import { claimEvent, handleInbound } from "../shared/inbound.ts";
import { normalizePhone, webhookKeyOk } from "../shared/channels.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("ok");
  if (!(await webhookKeyOk(req))) return new Response("forbidden", { status: 403 });
  const b = await req.json().catch(() => null);
  if (!b || b.is_outbound || b.group_id) return new Response("ok");
  const phone = normalizePhone(b.from_number ?? b.number ?? "");
  const id = b.message_handle ?? b.messageId;
  if (!phone || !id) return new Response("ok");
  const ev = {
    provider: "sendblue" as const, providerId: String(id), kinds: ["imessage" as const, "sms" as const],
    phone, text: String(b.content ?? ""), media: b.media_url ? [{ url: String(b.media_url), mime: "" }] : [],
  };
  if (!(await claimEvent(ev))) return new Response("ok");
  EdgeRuntime.waitUntil(handleInbound(ev).catch((e) => console.error("inbound sendblue", e)));
  return new Response("ok");
};
