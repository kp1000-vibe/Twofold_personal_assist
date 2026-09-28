// Chat: save the message, run it through instinct then thinking, save the reply, index both for the vault.
import { admin, handle, HttpError, json, requireUser } from "../shared/util.ts";
import { Attachment, runAgent } from "../shared/agent.ts";
import { indexText } from "../shared/knowledge.ts";
import { blockedMessage, budgetFor, markActive } from "../shared/plan.ts";

export default handle(async (req) => {
  const profile = await requireUser(req);
  const body = await req.json();
  const message = String(body.message ?? "").trim();
  const attachments: Attachment[] = Array.isArray(body.attachments)
    ? body.attachments.filter((a: any) => a && typeof a.path === "string" && a.path.startsWith(`${profile.id}/`)).slice(0, 5)
    : [];
  if (!message && !attachments.length) throw new HttpError(400, "Say something first");
  if (message.length > 4000) throw new HttpError(400, "That message is too long");
  const text = message || "Please look at the attached file.";
  const db = admin();
  const uid = profile.id;

  const { data: userMsg } = await db.from("messages").insert({
    user_id: uid, role: "user", content: text, meta: attachments.length ? { attachments: attachments.map((a) => ({ name: a.name, mime: a.mime })) } : {},
  }).select("id").single();

  const { data: history } = await db.from("messages").select("role, content, meta").eq("user_id", uid).order("created_at", { ascending: false }).limit(11);
  const past = (history ?? []).slice(1).reverse().map((m) => ({
    role: m.role,
    content: m.meta?.attachments?.length ? `${m.content}\n[attached: ${m.meta.attachments.map((x: any) => x.name).join(", ")}]` : m.content,
  }));

  await markActive(uid, "chat");
  const budget = await budgetFor(profile);
  if (budget.level === "blocked") {
    const { data: saved } = await db.from("messages").insert({ user_id: uid, role: "assistant", content: blockedMessage(budget), meta: { limit: true } }).select().single();
    return json({ message: saved });
  }
  const { reply, meta } = await runAgent(profile, text, { purpose: "chat", attachments, history: past, lite: budget.level === "lite" });
  if (budget.level === "lite") (meta as any).lite = true;
  const { data: saved } = await db.from("messages").insert({ user_id: uid, role: "assistant", content: reply, meta }).select().single();

  if (userMsg) await indexText(uid, "message", userMsg.id, `User said: ${text}`);
  if (saved && reply.length > 60) await indexText(uid, "message", saved.id, `Assistant replied: ${reply}`);
  return json({ message: saved });
});
