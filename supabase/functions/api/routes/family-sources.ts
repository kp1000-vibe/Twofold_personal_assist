// School and daycare plugins: list providers, add a calendar feed, get the family forwarding address, sync now.
import { admin, handle, HttpError, json, requireUser } from "../shared/util.ts";
import { getFamily, isAdult } from "../shared/family.ts";
import { inboxAddress, normalizeFeedUrl, PROVIDERS, syncSource } from "../shared/sources.ts";

export default handle(async (req) => {
  const profile = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const f = await getFamily(profile.id);
  if (!f) throw new HttpError(400, "Create or join a household first");
  const db = admin();
  const op = String(body.op ?? "providers");

  if (op === "providers") {
    const { data: inbox } = await db.from("family_sources").select("token").eq("household_id", f.household.id).eq("kind", "email").limit(1).maybeSingle();
    return json({ providers: PROVIDERS, inbox: inbox ? inboxAddress(inbox.token) : null, inbox_ready: !!Deno.env.get("POSTMARK_INBOUND_ADDRESS") });
  }
  if (!isAdult(f.me)) throw new HttpError(403, "Ask a parent to connect school and daycare");
  const kids = (Array.isArray(body.member_ids) ? body.member_ids : []).filter((id: string) => f.members.some((m) => m.id === id));

  if (op === "add_feed") {
    const url = normalizeFeedUrl(body.url);
    if (!url) throw new HttpError(400, "Paste a calendar link that starts with https or webcal");
    const provider = PROVIDERS[body.provider]?.kind === "ics" ? body.provider : "other_feed";
    const name = String(body.name ?? "").trim().slice(0, 80) || PROVIDERS[provider].label;
    const { count } = await db.from("family_sources").select("id", { count: "exact", head: true }).eq("household_id", f.household.id);
    if ((count ?? 0) >= 25) throw new HttpError(400, "That is a lot of calendars. Remove one first.");
    const { data: src, error } = await db.from("family_sources").insert({ household_id: f.household.id, kind: "ics", provider, name, url, member_ids: kids, created_by: profile.id }).select().single();
    if (error) throw new HttpError(400, error.message);
    const r = await syncSource(src.id);
    if ((r as any).error) {
      await db.from("family_sources").delete().eq("id", src.id);
      throw new HttpError(400, (r as any).error);
    }
    return json({ ok: true, source: src, sync: r });
  }
  if (op === "inbox") {
    if (!Deno.env.get("POSTMARK_INBOUND_ADDRESS")) throw new HttpError(400, "The family inbox is not switched on yet");
    let { data: src } = await db.from("family_sources").select("*").eq("household_id", f.household.id).eq("kind", "email").limit(1).maybeSingle();
    if (!src) {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
      src = (await db.from("family_sources").insert({ household_id: f.household.id, kind: "email", provider: "school_email", name: "Family inbox", token, member_ids: kids, created_by: profile.id }).select().single()).data;
    }
    return json({ ok: true, address: inboxAddress(src!.token) });
  }
  if (op === "sync") {
    const { data: src } = await db.from("family_sources").select("id").eq("id", body.id).eq("household_id", f.household.id).maybeSingle();
    if (!src) throw new HttpError(404, "Not found");
    return json(await syncSource(src.id));
  }
  throw new HttpError(400, "Unknown op");
});
