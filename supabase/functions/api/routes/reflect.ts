// On demand: run the week check now, or replay one decision now.
import { handle, HttpError, json, requireUser } from "../shared/util.ts";
import { runPremortem } from "../shared/premortem.ts";
import { runDecisionReplay } from "../shared/replay.ts";

export default handle(async (req) => {
  const profile = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  if (body.op === "premortem") return json(await runPremortem(profile, { manual: true }));
  if (body.op === "replay") {
    if (typeof body.id !== "string") throw new HttpError(400, "Which decision?");
    const r = await runDecisionReplay(profile, { id: body.id });
    if (!r) throw new HttpError(404, "That decision was already reviewed");
    return json(r);
  }
  throw new HttpError(400, "Unknown op");
});
