// Personal knowledge vault. Embeddings run inside the edge runtime (gte-small), so there is no extra API bill.
import { admin } from "./util.ts";

let session: any = null;
async function embed(text: string): Promise<number[] | null> {
  try {
    const ai = (globalThis as any).Supabase?.ai;
    if (!ai) return null;
    session ??= new ai.Session("gte-small");
    const out = await session.run(text.slice(0, 2000), { mean_pool: true, normalize: true });
    return Array.from(out as number[]);
  } catch (e) {
    console.error("embed", e);
    return null;
  }
}

/** Store or refresh one item in the vault. Never throws. */
export async function indexText(userId: string, sourceType: string, sourceId: string, content: string) {
  const text = content.trim();
  if (text.length < 12) return;
  const v = await embed(text);
  if (!v) return;
  const { error } = await admin().from("knowledge").upsert({
    user_id: userId, source_type: sourceType, source_id: sourceId, content: text.slice(0, 1500), embedding: JSON.stringify(v),
  }, { onConflict: "user_id,source_type,source_id" });
  if (error) console.error("index", error.message);
}

export async function searchKnowledge(userId: string, query: string, k = 8) {
  const v = await embed(query);
  if (!v) return [];
  const { data, error } = await admin().rpc("match_knowledge", { p_user: userId, p_embedding: JSON.stringify(v), p_k: k });
  if (error) {
    console.error("search", error.message);
    return [];
  }
  return (data ?? []).filter((r: any) => r.similarity > 0.72);
}
