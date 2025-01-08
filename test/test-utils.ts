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
  if (!resp.ok) {
    console.error(await resp.text());
  }
  expect(resp.ok).toEqual(true);
  return await resp.json();
}

export async function checkImage(
  filename: string,
  imageB64: string,
  options: { width: number; height: number; webpFrames: number } = {
    width: 512,
    height: 512,
    webpFrames: 1,
  }
): Promise<void> {
  const image = sharp(Buffer.from(imageB64, "base64"));
  const metadata = await image.metadata();
  expect(metadata.width).toEqual(options.width);
  expect(metadata.height).toEqual(options.height);
  if (filename.endsWith(".webp")) {
    expect(metadata.format).toEqual("webp");
    expect(metadata.pages).toEqual(options.webpFrames);
  } else if (filename.endsWith(".png")) {
    expect(metadata.format).toEqual("png");
  }
}
