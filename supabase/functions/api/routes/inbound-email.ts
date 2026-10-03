// Postmark inbound webhook for family inboxes: address+TOKEN@inbound.postmarkapp.com
import { webhookKeyOk } from "../shared/channels.ts";
import { handleFamilyEmail } from "../shared/sources.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("ok");
  if (!(await webhookKeyOk(req))) return new Response("forbidden", { status: 403 });
  const b = await req.json().catch(() => null);
  if (!b) return new Response("ok");
  const token = String(b.MailboxHash ?? "").trim() || String(b.OriginalRecipient ?? b.To ?? "").match(/\+([a-z0-9]+)@/i)?.[1] || "";
  if (!token) return new Response("ok");
  const text = String(b.TextBody || b.StrippedTextReply || "").trim() ||
    String(b.HtmlBody ?? "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  EdgeRuntime.waitUntil(handleFamilyEmail(token, {
    messageId: String(b.MessageID ?? crypto.randomUUID()), from: String(b.From ?? ""), fromName: String(b.FromName ?? ""),
    subject: String(b.Subject ?? "(no subject)"), text, date: String(b.Date ?? ""),
  }).catch((e) => console.error("family inbox", e)));
  return new Response("ok");
};
