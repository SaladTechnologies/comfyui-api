import { expect } from "earl";
import sharp from "sharp";
import fastify, { FastifyInstance } from "fastify";
import { fetch, Agent } from "undici";
import { S3Client } from "@aws-sdk/client-s3";
import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";
import { Webhook } from "svix";

export const s3 = new S3Client({
  region: "us-east-1",
  endpoint: "http://localhost:4566", // LocalStack endpoint
  credentials: {
    accessKeyId: "test",
    secretAccessKey: "test",
  },
  forcePathStyle: true, // Required for LocalStack
});

// Azurite connection string for local testing
const azuriteConnectionString =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;";

export const azureBlobClient = BlobServiceClient.fromConnectionString(
  azuriteConnectionString
);

export async function getAzureContainer(
  containerName: string
): Promise<ContainerClient> {
  const containerClient = azureBlobClient.getContainerClient(containerName);
  if (!(await containerClient.exists())) {
    await containerClient.create();
  }
  return containerClient;
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createWebhookListener(
  onReceive: (body: any, headers?: any) => void | Promise<void>,
  endpoint: string = "/webhook"
): Promise<FastifyInstance> {
  const app = fastify({
    bodyLimit: 1024 * 1024 * 1024, // 1 GB
  });
  app.post(endpoint, (req, res) => {
    if (req.body) {
      onReceive(req.body, req.headers);
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
  convert: any = undefined,
  upload: any = undefined,
  webhook_v2: boolean = false
): Promise<any> {
  const body: any = {
    prompt,
  };
  if (webhook) {
    body["webhook"] = webhookAddress;
  }
  if (webhook_v2) {
    body["webhook_v2"] = webhookAddress;
  }
  if (convert) {
    body["convert_output"] = convert;
  }
  // Handle different upload provider keys
  if (upload) {
    // For backward compatibility, if upload is passed directly as s3 config
    if (upload.bucket !== undefined || upload.prefix !== undefined) {
      body["s3"] = upload;
    } else {
      Object.assign(body, upload);
    }
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

const webhook = new Webhook("testsecret");

export function verifyWebhookV2(
  body: string,
  headers: Record<string, string>
): boolean {
  if (
    !headers["webhook-id"] ||
    !headers["webhook-timestamp"] ||
    !headers["webhook-signature"]
  ) {
    return false;
  }
  try {
    webhook.verify(body, headers);
    return true;
  } catch (e) {
    return false;
  }
}
