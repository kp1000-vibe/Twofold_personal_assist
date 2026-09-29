// Family thread: a member posts, and when they ask Twofold (mention it, or ask a question in a 2 person house)
// the assistant answers in the thread using only shared family information.
import { admin, handle, HttpError, json, requireUser } from "../shared/util.ts";
import { runAgent } from "../shared/agent.ts";
import { getFamily, postToThread } from "../shared/family.ts";
import { blockedMessage, budgetFor, markActive } from "../shared/plan.ts";
import { notify } from "../shared/trust.ts";

const MENTION = /(^|\s)@?twofold\b|^(hey|hi|ok)\s+twofold\b/i;

export default handle(async (req) => {
  const profile = await requireUser(req);
  const { message, ask } = await req.json();
  const text = String(message ?? "").trim();
  if (!text) throw new HttpError(400, "Say something first");
  if (text.length > 2000) throw new HttpError(400, "That message is too long");
  const fam = await getFamily(profile.id);
  if (!fam) throw new HttpError(400, "Create or join a household first");
  await markActive(profile.id, "family");

  const hid = fam.household.id;
  await postToThread(hid, text, {}, { user: profile.id, name: fam.me.name });

  // everyone else in the house gets a quiet heads up
  for (const m of fam.members) {
    if (!m.user_id || m.user_id === profile.id) continue;
    await notify({ user_id: m.user_id, title: `${fam.me.name} in ${fam.household.name}`, body: text.slice(0, 140), link: "#/family", why: "New message in your family thread", importance: MENTION.test(text) ? 1.6 : 1.1 });
  }

  if (!ask && !MENTION.test(text)) return json({ ok: true, replied: false });

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
  const { reply, meta } = await runAgent(profile, text.replace(MENTION, " ").trim() || text, { purpose: "family", history, familyThread: true, lite: budget.level === "lite" });
  await postToThread(hid, reply, { ...meta, asked_by: fam.me.name });
  return json({ ok: true, replied: true });
});
