// Family thread: a member posts, and when they ask Twofold (mention it, or ask a question in a 2 person house)
// the assistant answers in the thread using only shared family information.
import { admin, handle, HttpError, json, requireUser } from "../shared/util.ts";
import { Attachment, runAgent } from "../shared/agent.ts";
import { getFamily, postToThread } from "../shared/family.ts";
import { blockedMessage, budgetFor, markActive } from "../shared/plan.ts";
import { notify } from "../shared/trust.ts";

const MENTION = /(^|\s)@?twofold\b|^(hey|hi|ok)\s+twofold\b/i;

export default handle(async (req) => {
  const profile = await requireUser(req);
  const body = await req.json();
  const { ask } = body;
  const text = String(body.message ?? "").trim();
  if (text.length > 2000) throw new HttpError(400, "That message is too long");
  const fam = await getFamily(profile.id);
  if (!fam) throw new HttpError(400, "Create or join a household first");
  const attachments: Attachment[] = Array.isArray(body.attachments)
    ? body.attachments.filter((a: any) => a && typeof a.path === "string" && a.path.startsWith(`family/${fam.household.id}/`)).slice(0, 4)
    : [];
  if (!text && !attachments.length) throw new HttpError(400, "Say something first");
  await markActive(profile.id, "family");

  const hid = fam.household.id;
  await postToThread(hid, text || "📷 Photo", attachments.length ? { attachments } : {}, { user: profile.id, name: fam.me.name });

  // everyone else in the house gets a quiet heads up
  for (const m of fam.members) {
    if (!m.user_id || m.user_id === profile.id) continue;
    await notify({ user_id: m.user_id, title: `${fam.me.name} in ${fam.household.name}`, body: (text || "📷 Photo").slice(0, 140), link: "#/family", why: "New message in your family chat", importance: 1.6 });
  }

  // a photo (school flyer, schedule, receipt) always gets a look from Twofold
  if (!ask && !MENTION.test(text) && !attachments.length) return json({ ok: true, replied: false });

  const budget = await budgetFor(profile);
  if (budget.level === "blocked") {
    await postToThread(hid, blockedMessage(budget), { limit: true });
    return json({ ok: true, replied: true });
  }
  const { data: recent } = await admin().from("family_messages").select("author_name, author_user, content").eq("household_id", hid).order("created_at", { ascending: false }).limit(12);
  const history = (recent ?? []).slice(1).reverse().map((m) => ({
    role: m.author_user ? "user" : "assistant",
    content: m.author_user ? `${m.author_name}: ${m.content}` : m.content,
  }));
  const prompt = text.replace(MENTION, " ").trim() || (attachments.length ? "Look at this photo. If it has dates, events, forms, fees or things to bring, add them to the family calendar and lists, then say what you added." : text);
  const { reply, meta } = await runAgent(profile, prompt, { purpose: "family", history, familyThread: true, attachments, lite: budget.level === "lite" });
  await postToThread(hid, reply, { ...meta, asked_by: fam.me.name });
  return json({ ok: true, replied: true });
});
