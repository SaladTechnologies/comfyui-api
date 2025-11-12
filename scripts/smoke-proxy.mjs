import fastify from "fastify";
import { fetch } from "undici";
import { getProxyDispatcher } from "../dist/src/proxy-dispatcher.js";

async function main() {
  const app = fastify({ logger: true });
  app.post("/webhook", async (req, reply) => {
    return reply.send({ success: true, received: req.body || null });
  });

  await app.listen({ port: 12345, host: "127.0.0.1" });
  await app.ready();

  console.log("Local webhook server listening on http://127.0.0.1:12345/webhook");

  const resp = await fetch("http://127.0.0.1:12345/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ping: true }),
    dispatcher: getProxyDispatcher(),
  });

  console.log("Fetch status:", resp.status, resp.statusText);
  const body = await resp.json();
  console.log("Response:", body);

  await app.close();
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});

