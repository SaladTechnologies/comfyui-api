import { expect } from "earl";
import sharp from "sharp";
import fastify, { FastifyInstance } from "fastify";

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForWebhook(
  onReceive: (body: any) => void
): Promise<FastifyInstance> {
  const app = fastify();
  app.post("/webhook", async (req, res) => {
    res.send({ success: true });
    onReceive(req.body);
  });
  await app.listen({ port: 1234 });
  await app.ready();
  return app;
}

const webhookAddress = "http://host.docker.internal:1234/webhook";

export async function submitPrompt(
  prompt: any,
  webhook: boolean = false
): Promise<any> {
  const body: any = {
    prompt,
  };
  if (webhook) {
    body["webhook"] = webhookAddress;
  }
  const resp = await fetch(`http://localhost:3000/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(resp.ok).toEqual(true);
  return await resp.json();
}

export async function checkImage(
  filename: string,
  imageB64: string,
  webpFrames = 10
): Promise<void> {
  const image = sharp(Buffer.from(imageB64, "base64"));
  const metadata = await image.metadata();
  expect(metadata.width).toEqual(512);
  expect(metadata.height).toEqual(512);
  if (filename.endsWith(".webp")) {
    expect(metadata.format).toEqual("webp");
    expect(metadata.pages).toEqual(webpFrames);
  } else if (filename.endsWith(".png")) {
    expect(metadata.format).toEqual("png");
  }
}
