import { handle, HttpError, json, requireUser } from "../shared/util.ts";
import { undoActivity } from "../shared/trust.ts";

export default handle(async (req) => {
  const profile = await requireUser(req);
  const { activity_id } = await req.json();
  if (!activity_id) throw new HttpError(400, "Bad request");
  return json(await undoActivity(profile, activity_id));
});
