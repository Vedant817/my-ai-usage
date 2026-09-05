import { serve } from "@hono/node-server";
import { createApp } from "./routes.js";
import { maybeStartDigestLoop } from "./digest.js";

const port = Number(process.env.PORT ?? 8787);
const app = createApp();
maybeStartDigestLoop();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`usage-dash server on :${info.port}`);
});
