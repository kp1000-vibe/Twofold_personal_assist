// Accept or decline something Twofold proposed in the family chat (adults only).
import { handle, HttpError, json, requireUser } from "../shared/util.ts";
import { decideProposal } from "../shared/familyAgent.ts";
import { markActive } from "../shared/plan.ts";

export default handle(async (req) => {
  const profile = await requireUser(req);
  const { proposal_id, decision, edits } = await req.json();
  if (typeof proposal_id !== "string" || !["accept", "decline"].includes(decision)) throw new HttpError(400, "Bad request");
  await markActive(profile.id, "family");
  try {
    return json({ ok: true, result: await decideProposal(profile, proposal_id, decision, edits ?? {}) });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
});
