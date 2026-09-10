import { serve } from "@hono/node-server";
import { loadEnv } from "./env.js";
import { createApp } from "./routes.js";
import { maybeStartDigestLoop } from "./digest.js";

loadEnv();
const port = Number(process.env.PORT ?? 8787);
const app = createApp();
maybeStartDigestLoop();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`usage-dash server on :${info.port}`);
});
