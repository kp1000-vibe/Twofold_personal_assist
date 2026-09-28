// One edge function, many routes: /functions/v1/api/<route>
import chat from "./routes/chat.ts";
import googleOauth from "./routes/google-oauth.ts";
import syncInbox from "./routes/sync-inbox.ts";
import dailyBrief from "./routes/daily-brief.ts";
import executeAction from "./routes/execute-action.ts";
import reminders from "./routes/reminders.ts";
import { cors, json } from "./shared/util.ts";

const routes: Record<string, (req: Request) => Promise<Response>> = {
  chat,
  "google-oauth": googleOauth,
  "sync-inbox": syncInbox,
  "daily-brief": dailyBrief,
  "execute-action": executeAction,
  reminders,
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const route = routes[parts[parts.length - 1]];
  if (!route) return json({ error: "Not found" }, 404);
  return route(req);
});
