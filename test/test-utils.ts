import { expect } from "earl";
import sharp from "sharp";
import fastify, { FastifyInstance } from "fastify";
import { fetch, Agent } from "undici";

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createWebhookListener(
  onReceive: (body: any) => void | Promise<void>,
  endpoint: string = "/webhook"
): Promise<FastifyInstance> {
  const app = fastify({
    bodyLimit: 1024 * 1024 * 1024, // 1 GB
  });
  app.post(endpoint, (req, res) => {
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
  webhook: boolean = false,
  convert: any = undefined
): Promise<any> {
  const body: any = {
    prompt,
  };
  if (webhook) {
    body["webhook"] = webhookAddress;
  }
  if (convert) {
    body["convert_output"] = convert;
  }
  try {
    const resp = await fetch(`http://localhost:3000/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      dispatcher: new Agent({
        headersTimeout: 0,
        bodyTimeout: 0,
        connectTimeout: 0,
      }),
    });
    if (!resp.ok) {
      console.error(await resp.text());
      throw new Error("Prompt submission failed");
    }
    expect(resp.ok).toEqual(true);
    return await resp.json();
  } catch (e) {
    console.error(e);
    throw e;
  }
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
  } else if (filename.endsWith(".jpeg") || filename.endsWith(".jpg")) {
    expect(metadata.format).toEqual("jpeg");
  }
}

export async function waitForServerToBeReady(): Promise<void> {
  while (true) {
    try {
      const resp = await fetch(`http://localhost:3000/ready`);
      if (resp.ok) {
        break;
      }
    } catch (e) {}
    await sleep(100);
  }
}
