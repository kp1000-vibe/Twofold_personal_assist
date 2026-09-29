// Teen safety: every teen message and every reply to a teen is screened by Jev before and after Claude.
// Flags are logged for review. Follows Anthropic's guidance for organizations serving minors.
import { admin, clip } from "./util.ts";
import { jev, noul } from "./ai.ts";

export const TEEN_SYSTEM = [
  "The user is a teenager (13 to 17). Their parent or guardian invited them.",
  "Be warm, clear and age appropriate. You are an AI assistant, never pretend to be a person; if asked, say plainly that you are an AI.",
  "Help with school, schedules, chores, family plans, hobbies and everyday questions.",
  "Never produce sexual or romantic content, never help with alcohol, drugs, vaping, gambling, weapons, dangerous challenges, or ways to hide things from parents that could put them at risk.",
  "Never ask for or encourage sharing personal details like address, school name or photos with strangers, and never help arrange meeting someone they met online.",
  "If they mention self harm, suicide, abuse, or being in danger: respond with care, encourage them to talk to a trusted adult, and share that in the US they can call or text 988 (Suicide and Crisis Lifeline) or, if in immediate danger, call 911. Do not diagnose.",
  "For health, legal or money questions, give general information and suggest talking with a parent, school counselor or doctor.",
].join("\n");

const CATEGORIES: Record<string, string> = {
  self_harm: "mentions wanting to hurt themselves, suicide, self harm, or disordered eating",
  sexual: "is sexual or romantic in nature, or asks for sexual content",
  danger: "asks about drugs, alcohol, vaping, weapons, violence, or dangerous challenges",
  exploitation: "suggests an adult or stranger is asking them for photos, secrets, personal details, or to meet up",
  abuse: "mentions being hurt, threatened or abused by someone",
};

export type Screen = { flagged: string[]; scores: Record<string, number> };

export async function screen(userId: string, text: string, direction: "in" | "out"): Promise<Screen> {
  const qs: Record<string, any> = {};
  for (const [k, v] of Object.entries(CATEGORIES)) {
    qs[k] = { type: "noul", instructions: `Does \`text\` (${direction === "in" ? "written by a teenager" : "written to a teenager by an AI assistant"}) contain content that ${v}?` };
  }
  const { answers } = await jev(userId, `teen_screen_${direction}`, { text: clip(text, 4000) }, qs);
  const scores: Record<string, number> = {};
  for (const k of Object.keys(CATEGORIES)) scores[k] = noul(answers, k);
  const flagged = Object.entries(scores).filter(([, s]) => s > 0.7).map(([k]) => k);
  if (flagged.length) {
    const { error } = await admin().from("safety_flags").insert(flagged.map((category) => ({
      user_id: userId, direction, category, score: scores[category], excerpt: clip(text, 240),
    })));
    if (error) console.error("safety_flags", error.message);
  }
  return { flagged, scores };
}

/** Extra instruction for the model when the teen's message was flagged. */
export function flaggedGuidance(s: Screen): string {
  if (!s.flagged.length) return "";
  const parts: string[] = [];
  if (s.flagged.includes("self_harm") || s.flagged.includes("abuse")) parts.push("This message may involve self harm, abuse or danger. Respond with warmth first. Encourage talking to a trusted adult. Share 988 (call or text, US) and 911 for immediate danger.");
  if (s.flagged.includes("exploitation")) parts.push("Someone may be pressuring them. Tell them clearly they did nothing wrong, not to send anything or meet, and to tell a parent or trusted adult now.");
  if (s.flagged.includes("sexual") || s.flagged.includes("danger")) parts.push("Decline the unsafe part kindly in one sentence and offer a safe, helpful alternative.");
  return parts.join(" ");
}

export const SAFE_FALLBACK = "I can't help with that one. If something is worrying you, talking to a parent or another adult you trust really helps. If you ever feel unsafe or think about hurting yourself, you can call or text 988 anytime, or call 911 in an emergency.";
