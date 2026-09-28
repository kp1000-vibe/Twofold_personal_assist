// Delete my account: revoke Google, remove uploaded files, then delete the user (all rows cascade).
import { admin, handle, HttpError, json } from "../shared/util.ts";
import { accessToken } from "../shared/google.ts";

export default handle(async (req) => {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const db = admin();
  const { data: auth } = token ? await db.auth.getUser(token) : { data: { user: null } };
  const user = auth?.user;
  if (!user) throw new HttpError(401, "Sign in first");
  const body = await req.json().catch(() => ({}));
  if (body.op !== "delete" || body.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm");

  // tell Google to forget the grant
  try {
    const t = await accessToken(user.id);
    if (t) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: "POST" });
  } catch (e) {
    console.error("revoke", e);
  }
  // uploaded files live outside the database, remove them first
  for (let i = 0; i < 20; i++) {
    const { data: files } = await db.storage.from("uploads").list(user.id, { limit: 100 });
    if (!files?.length) break;
    await db.storage.from("uploads").remove(files.map((f) => `${user.id}/${f.name}`));
  }
  const { error } = await db.auth.admin.deleteUser(user.id);
  if (error) throw new HttpError(500, `Could not delete: ${error.message}`);
  return json({ ok: true });
});
