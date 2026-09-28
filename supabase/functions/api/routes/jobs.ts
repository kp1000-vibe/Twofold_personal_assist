// Background execution: every 2 minutes pick up queued jobs and keep working after the app is closed.
import { plain } from "../shared/channels.ts";
import { admin, clip, handle, HttpError, isCron, json, Profile } from "../shared/util.ts";
import { runAgent } from "../shared/agent.ts";
import { blockedMessage, budgetFor } from "../shared/plan.ts";
import { logActivity, notify } from "../shared/trust.ts";
import { indexText } from "../shared/knowledge.ts";

export default handle(async (req) => {
  if (!(await isCron(req))) throw new HttpError(401, "Scheduled job only");
  const db = admin();
  // jobs stuck for 15 minutes (a crashed run) go back in the queue once
  await db.from("jobs").update({ status: "queued" }).eq("status", "running").lt("started_at", new Date(Date.now() - 15 * 60_000).toISOString());
  const { data: queued } = await db.from("jobs").select("*").eq("status", "queued").order("created_at").limit(2);
  let done = 0;
  for (const job of queued ?? []) {
    const { data: claimed } = await db.from("jobs").update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", job.id).eq("status", "queued").select("id").maybeSingle();
    if (!claimed) continue;
    const { data: profile } = await db.from("profiles").select("*").eq("id", job.user_id).single();
    try {
      const budget = await budgetFor(profile as Profile);
      if (budget.level !== "ok") throw new Error(blockedMessage(budget));
      const { reply, meta } = await runAgent(profile as Profile, job.task, { purpose: "background", background: true });
      await db.from("jobs").update({ status: "done", result: reply, finished_at: new Date().toISOString() }).eq("id", job.id);
      const { data: msg } = await db.from("messages").insert({ user_id: job.user_id, role: "assistant", content: `**Background job finished:** ${clip(job.task, 120)}\n\n${reply}`, meta: { ...meta, background: true, job_id: job.id } }).select("id").single();
      if (msg) await indexText(job.user_id, "message", msg.id, `Background result for ${job.task}: ${reply}`);
      await notify({ user_id: job.user_id, title: `Done: ${clip(job.task, 80)}`, body: clip(reply, 140), link: "#/chat", why: "You asked me to work on this in the background", importance: 2.5, text: `Done: ${clip(job.task, 80)}\n\n${plain(reply)}` });
      await logActivity({ user_id: job.user_id, kind: "job_done", title: `Finished background job: ${clip(job.task, 100)}`, why: "You handed it off in chat", ref_type: "job", ref_id: job.id });
      done++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.from("jobs").update({ status: "failed", result: msg, finished_at: new Date().toISOString() }).eq("id", job.id);
      await notify({ user_id: job.user_id, title: `Could not finish: ${clip(job.task, 80)}`, body: msg, link: "#/chat", why: "A background job you started failed", importance: 2 });
    }
  }
  return json({ ran: done });
});
