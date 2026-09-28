// Approve or discard an item in the Approvals tab, or cancel a rule approved one inside its undo window.
import { admin, handle, HttpError, json, requireUser } from "../shared/util.ts";
import { logActivity, performAction } from "../shared/trust.ts";

export default handle(async (req) => {
  const profile = await requireUser(req);
  const { action_id, decision, edits } = await req.json();
  if (!action_id || !["approve", "reject"].includes(decision)) throw new HttpError(400, "Bad request");
  const db = admin();
  const { data: action } = await db.from("actions").select("*").eq("id", action_id).eq("user_id", profile.id).maybeSingle();
  if (!action) throw new HttpError(404, "Not found");
  if (!["pending", "scheduled"].includes(action.status)) throw new HttpError(409, "Already handled");

  if (decision === "reject") {
    const status = action.status === "scheduled" ? "undone" : "rejected";
    await db.from("actions").update({ status, decided_at: new Date().toISOString() }).eq("id", action.id);
    await logActivity({
      user_id: profile.id, kind: status === "undone" ? "undone" : "discarded",
      title: `${status === "undone" ? "Cancelled" : "Discarded"}: ${action.title}`, why: "You said no", ref_type: "action", ref_id: action.id,
    });
    return json({ ok: true, status });
  }
  const result = await performAction(profile, action, edits);
  return json({ ok: true, status: "done", result });
});
