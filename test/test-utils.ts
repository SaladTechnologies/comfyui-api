import { expect } from "earl";
import sharp from "sharp";
import fastify, { FastifyInstance } from "fastify";

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createWebhookListener(
  onReceive: (body: any) => void | Promise<void>
): Promise<FastifyInstance> {
  const app = fastify({
    bodyLimit: 1024 * 1024 * 1024, // 1 GB
  });
  app.post("/webhook", (req, res) => {
    if (req.body) {
      onReceive(req.body);
    }
    res.send({ success: true });
  });
  await app.listen({ port: 1234 });
  await app.ready();
  /**
   * TODO: There is some kind of race condition here I can't figure out.
   * comfyui-api logs report that it got no response from the webhook if this
   * value is smaller.
   * */
  await sleep(700);
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
    signal: AbortSignal.timeout(1000 * 60 * 60 * 20), // 20 minutes
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
  options: { width: number; height: number; webpFrames?: number } = {
    width: 512,
    height: 512,
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

export async function waitForServerToStart(): Promise<void> {
  while (true) {
    try {
      const resp = await fetch(`http://localhost:3000/health`);
      if (resp.ok) {
        break;
      }
    } catch (e) {}
    await sleep(100);
  }
}
