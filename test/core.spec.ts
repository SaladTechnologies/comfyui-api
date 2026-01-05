import { expect } from "earl";
import path from "path";
import fs from "fs";
import { fetch, Agent } from "undici";
import {
  sleep,
  createWebhookListener,
  submitPrompt,
  checkImage,
  waitForServerToBeReady,
  s3,
  getAzureContainer,
  verifyWebhookV2,
} from "./test-utils";
import sd15Txt2Img from "./workflows/sd1.5-txt2img.json";
import sd15Img2Img from "./workflows/sd1.5-img2img.json";
import sd15MultiOutput from "./workflows/sd1.5-multi-output.json";
import sd15Parallel2 from "./workflows/sd1.5-parallel-2.json";
import sd15Parallel3 from "./workflows/sd1.5-parallel-3.json";
import {
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsCommand,
} from "@aws-sdk/client-s3";

const bucketName = "salad-benchmark-test";
const pngKey = "test-image.png";
const azureContainerName = "test-container";
const webhookAddress = "http://host.docker.internal:1234/webhook";

// Helper function to convert stream to buffer
async function streamToBuffer(
  readableStream: NodeJS.ReadableStream
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    readableStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    readableStream.on("error", reject);
    readableStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const sd15Txt2ImgBatch4 = JSON.parse(JSON.stringify(sd15Txt2Img));
sd15Txt2ImgBatch4["5"].inputs.batch_size = 4;

const inputPng = fs.readFileSync(
  path.join(__dirname, "input-images", "doodle-girl.png")
);

const inputPngBase64 = inputPng.toString("base64");
sd15Img2Img["10"].inputs.image = inputPngBase64;

const sd15Img2ImgWithHttpUrl = JSON.parse(JSON.stringify(sd15Img2Img));
sd15Img2ImgWithHttpUrl["10"].inputs.image =
  "https://salad-benchmark-assets.download/coco2017/train2017/000000000009.jpg";

const sd15Img2ImgWithS3Url = JSON.parse(JSON.stringify(sd15Img2Img));
sd15Img2ImgWithS3Url["10"].inputs.image = `s3://${bucketName}/${pngKey}`;

const sd15Img2ImgWithAzureUrl = JSON.parse(JSON.stringify(sd15Img2Img));
// Use azurite hostname for Docker network access
sd15Img2ImgWithAzureUrl[
  "10"
].inputs.image = `http://azurite:10000/devstoreaccount1/${azureContainerName}/${pngKey}`;

const sd15Img2ImgWithJpeg = JSON.parse(JSON.stringify(sd15Img2Img));
const inputJpeg = fs
  .readFileSync(path.join(__dirname, "input-images", "food.jpg"))
  .toString("base64");
sd15Img2ImgWithJpeg["10"].inputs.image = inputJpeg;

describe("Stable Diffusion 1.5", () => {
  before(async () => {
    await waitForServerToBeReady();
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucketName,
      })
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: pngKey,
        Body: inputPng,
        ContentType: "image/png",
      })
    );
    // Purge the HTTP file server before seeding
    await fetch(`http://localhost:8080/purge`, {
      method: "DELETE",
    });
    // Seed the HTTP file server with test image
    await fetch(`http://localhost:8080/${pngKey}`, {
      method: "PUT",
      body: inputPng,
      headers: {
        "Content-Type": "image/png",
      },
    });
    // Seed the Azure Blob container with test image
    const azureContainer = await getAzureContainer(azureContainerName);
    const blockBlobClient = azureContainer.getBlockBlobClient(pngKey);
    await blockBlobClient.upload(inputPng, inputPng.length, {
      blobHTTPHeaders: { blobContentType: "image/png" },
    });
  });
  describe("Return content in response", () => {
    it("text2image works with 1 image", async () => {
      const respBody = await submitPrompt(sd15Txt2Img);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0]);
    });

    it("text2image works with multiple images", async () => {
      const respBody = await submitPrompt(sd15Txt2ImgBatch4);
      expect(respBody.filenames.length).toEqual(4);
      expect(respBody.images.length).toEqual(4);
      for (let i = 0; i < respBody.filenames.length; i++) {
        await checkImage(respBody.filenames[i], respBody.images[i]);
      }
    });

    it("image2image works with base64 encoded png", async () => {
      const respBody = await submitPrompt(sd15Img2Img);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 768,
        height: 768,
      });
    });

    it("image2image works with base64 encoded jpeg", async () => {
      const respBody = await submitPrompt(sd15Img2ImgWithJpeg);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 640,
        height: 480,
      });
    });

    it("image2image works with http image url", async () => {
      const respBody = await submitPrompt(sd15Img2ImgWithHttpUrl);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 640,
        height: 480,
      });
    });

    it("image2image works with s3 image url", async () => {
      const respBody = await submitPrompt(sd15Img2ImgWithS3Url);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 768,
        height: 768,
      });
    });

    it("image2image works with azure blob image url", async () => {
      const respBody = await submitPrompt(sd15Img2ImgWithAzureUrl);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 768,
        height: 768,
      });
    });

    it("image2image works with hf image url in model repo", async () => {
      // First, upload an image to HF model repo to use as source
      const timestamp = Date.now();
      const uploadResp = await submitPrompt(sd15Txt2Img, false, undefined, {
        hf_upload: {
          repo: "SaladTechnologies/comfyui-api-integration-testing",
          repo_type: "model",
          directory: `test-source-images-${timestamp}`,
        },
      });

      // Extract the URL of the uploaded image
      const hfImageUrl = uploadResp.images[0];

      // Now use this HF URL as input for img2img
      const sd15Img2ImgWithHfUrl = JSON.parse(JSON.stringify(sd15Img2Img));
      sd15Img2ImgWithHfUrl["10"].inputs.image = hfImageUrl;

      const respBody = await submitPrompt(sd15Img2ImgWithHfUrl);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 512,
        height: 512,
      });
    });

    it("image2image works with hf image url in dataset repo", async () => {
      // First, upload an image to HF dataset repo to use as source
      const timestamp = Date.now();
      const uploadResp = await submitPrompt(sd15Txt2Img, false, undefined, {
        hf_upload: {
          repo: "SaladTechnologies/comfyui-api-integration-testing",
          repo_type: "dataset",
          directory: `test-source-images-dataset-${timestamp}`,
        },
      });

      // Extract the URL of the uploaded image
      const hfImageUrl = uploadResp.images[0];

      // Now use this HF URL as input for img2img
      const sd15Img2ImgWithHfDatasetUrl = JSON.parse(
        JSON.stringify(sd15Img2Img)
      );
      sd15Img2ImgWithHfDatasetUrl["10"].inputs.image = hfImageUrl;

      const respBody = await submitPrompt(sd15Img2ImgWithHfDatasetUrl);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 512,
        height: 512,
      });
    });

    it("image2image works with hf url containing spaces in path", async () => {
      // First, upload an image to HF with a directory name containing spaces
      // This tests that URL-encoded spaces (%20) are properly decoded when downloading
      const timestamp = Date.now();
      const uploadResp = await submitPrompt(sd15Txt2Img, false, undefined, {
        hf_upload: {
          repo: "SaladTechnologies/comfyui-api-integration-testing",
          repo_type: "dataset",
          directory: `test source images ${timestamp}`, // Directory with spaces
        },
      });

      // Extract the URL - it should contain %20 for the spaces
      const hfImageUrl = uploadResp.images[0];
      expect(hfImageUrl.includes("%20")).toBeTruthy();

      // Now use this HF URL as input for img2img - this will trigger the download
      // which requires proper URL decoding to work
      const sd15Img2ImgWithSpacesUrl = JSON.parse(JSON.stringify(sd15Img2Img));
      sd15Img2ImgWithSpacesUrl["10"].inputs.image = hfImageUrl;

      const respBody = await submitPrompt(sd15Img2ImgWithSpacesUrl);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 512,
        height: 512,
      });
    });

    it("works if the workflow has multiple output nodes", async () => {
      const respBody = await submitPrompt(sd15MultiOutput);
      expect(respBody.filenames.length).toEqual(2);
      expect(respBody.images.length).toEqual(2);
    });

    it("works if there are 2 parallel, non-interrelated workflows (also tests http model download)", async () => {
      const respBody = await submitPrompt(sd15Parallel2);
      expect(respBody.filenames.length).toEqual(2);
      expect(respBody.images.length).toEqual(2);
    });

    it("works if there are 3 parallel, non-interrelated workflows (also tests hf model download)", async () => {
      const respBody = await submitPrompt(sd15Parallel3);
      expect(respBody.filenames.length).toEqual(3);
      expect(respBody.images.length).toEqual(3);
    });

    it("can convert to jpeg", async () => {
      const respBody = await submitPrompt(sd15Txt2Img, false, {
        format: "jpeg",
      });
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      expect(respBody.filenames[0].endsWith(".jpeg")).toBeTruthy();
      await checkImage(respBody.filenames[0], respBody.images[0]);
    });

    it("can convert to webp", async () => {
      const respBody = await submitPrompt(sd15Txt2Img, false, {
        format: "webp",
      });
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      expect(respBody.filenames[0].endsWith(".webp")).toBeTruthy();
      await checkImage(respBody.filenames[0], respBody.images[0]);
    });
  });

  describe("Return content in webhook", () => {
    it("text2image works with 1 image", async () => {
      let expected = 1;
      const webhook = await createWebhookListener(async (body) => {
        expected--;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image);
      });
      const { id: reqId } = await submitPrompt(sd15Txt2Img, true);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });

    it("text2image works with multiple images", async () => {
      let expected = 4;
      const webhook = await createWebhookListener(async (body) => {
        expected--;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image);
      });
      const { id: reqId } = await submitPrompt(sd15Txt2ImgBatch4, true);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });

    it("image2image works with base64 encoded images", async () => {
      let expected = 1;
      const webhook = await createWebhookListener(async (body) => {
        expected--;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image, {
          width: 768,
          height: 768,
        });
      });
      const { id: reqId } = await submitPrompt(sd15Img2Img, true);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });
  });

  describe("Return content in webhook - v2", () => {
    const submitPromptWebhookV2 = async (prompt: any, upload?: any) => {
      return submitPrompt(prompt, false, undefined, upload, true);
    };
    it("text2image works with 1 image", async () => {
      let expected = 1;
      const responses: any[] = [];
      const webhook = await createWebhookListener(async (body, headers) => {
        responses.push({ body, headers });
        expected--;
      });
      const { id: reqId } = await submitPromptWebhookV2(sd15Txt2Img);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
      for (const resp of responses) {
        expect(
          verifyWebhookV2(JSON.stringify(resp.body), resp.headers)
        ).toEqual(true);
        expect(resp.body.id).toEqual(reqId);
        expect(resp.headers["webhook-id"]).toEqual(reqId);
        expect(resp.body.filenames.length).toEqual(1);
        expect(resp.body.images.length).toEqual(1);
        await checkImage(resp.body.filenames[0], resp.body.images[0]);
      }
    });

    it("text2image works with multiple images", async () => {
      let expected = 1;
      const responses: any[] = [];
      const webhook = await createWebhookListener(async (body, headers) => {
        responses.push({ body, headers });
        expected--;
      });
      const { id: reqId } = await submitPromptWebhookV2(sd15Txt2ImgBatch4);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
      for (const resp of responses) {
        expect(
          verifyWebhookV2(JSON.stringify(resp.body), resp.headers)
        ).toEqual(true);
        expect(resp.body.id).toEqual(reqId);
        expect(resp.headers["webhook-id"]).toEqual(reqId);
        expect(resp.body.filenames.length).toEqual(4);
        expect(resp.body.images.length).toEqual(4);
        for (let i = 0; i < resp.body.filenames.length; i++) {
          await checkImage(resp.body.filenames[i], resp.body.images[i]);
        }
      }
    });

    it("image2image works with base64 encoded images", async () => {
      let expected = 1;
      const responses: any[] = [];
      const webhook = await createWebhookListener(async (body, headers) => {
        responses.push({ body, headers });
        expected--;
      });
      const { id: reqId } = await submitPromptWebhookV2(sd15Img2Img);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
      for (const resp of responses) {
        expect(
          verifyWebhookV2(JSON.stringify(resp.body), resp.headers)
        ).toEqual(true);
        expect(resp.body.id).toEqual(reqId);
        expect(resp.headers["webhook-id"]).toEqual(reqId);
        expect(resp.body.filenames.length).toEqual(1);
        expect(resp.body.images.length).toEqual(1);
        await checkImage(resp.body.filenames[0], resp.body.images[0], {
          width: 768,
          height: 768,
        });
      }
    });

    it("works with s3 uploads", async () => {
      let expected = 1;
      const responses: any[] = [];
      const webhook = await createWebhookListener(async (body, headers) => {
        expected--;
        responses.push({ body, headers });
      });
      const { id: reqId } = await submitPromptWebhookV2(sd15Img2Img, {
        bucket: bucketName,
        prefix: "sd15-img2img/",
      });
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
      for (const resp of responses) {
        expect(
          verifyWebhookV2(JSON.stringify(resp.body), resp.headers)
        ).toEqual(true);
        expect(resp.body.id).toEqual(reqId);
        expect(resp.headers["webhook-id"]).toEqual(reqId);
        expect(resp.body.filenames.length).toEqual(1);
        expect(resp.body.images.length).toEqual(1);
        expect(
          resp.body.images[0].startsWith("s3://") &&
            resp.body.images[0].endsWith(".png")
        ).toBeTruthy();
        const s3Url = new URL(resp.body.images[0]);
        const bucket = s3Url.hostname;
        const key = s3Url.pathname.slice(1);
        const s3Resp = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        );
        const imageBuffer = Buffer.from(
          await s3Resp.Body!.transformToByteArray()
        );
        await checkImage(key, imageBuffer.toString("base64"), {
          width: 768,
          height: 768,
        });
      }
    });
  });

  describe("Upload to S3 and return S3 URL", () => {
    it("text2image works with 1 image", async () => {
      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        bucket: bucketName,
        prefix: "sd15-txt2img/",
        async: false,
      });
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      expect(
        respBody.images[0].startsWith("s3://") &&
          respBody.images[0].endsWith(".png")
      ).toBeTruthy();
      const s3Url = new URL(respBody.images[0]);
      const bucket = s3Url.hostname;
      const key = s3Url.pathname.slice(1);
      const s3Resp = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      const imageBuffer = Buffer.from(
        await s3Resp.Body!.transformToByteArray()
      );
      await checkImage(key, imageBuffer.toString("base64"));
    });

    it("works with convert_output to webp (fixes SharedArrayBuffer issue #121)", async () => {
      const respBody = await submitPrompt(
        sd15Txt2Img,
        false,
        { format: "webp" },
        {
          bucket: bucketName,
          prefix: "sd15-txt2img-convert-webp/",
          async: false,
        }
      );
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      expect(respBody.filenames[0].endsWith(".webp")).toBeTruthy();
      expect(
        respBody.images[0].startsWith("s3://") &&
          respBody.images[0].endsWith(".webp")
      ).toBeTruthy();
      const s3Url = new URL(respBody.images[0]);
      const bucket = s3Url.hostname;
      const key = s3Url.pathname.slice(1);
      const s3Resp = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      const imageBuffer = Buffer.from(
        await s3Resp.Body!.transformToByteArray()
      );
      await checkImage(key, imageBuffer.toString("base64"));
    });

    it("works with convert_output to jpeg (fixes SharedArrayBuffer issue #121)", async () => {
      const respBody = await submitPrompt(
        sd15Txt2Img,
        false,
        { format: "jpeg" },
        {
          bucket: bucketName,
          prefix: "sd15-txt2img-convert-jpeg/",
          async: false,
        }
      );
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      expect(respBody.filenames[0].endsWith(".jpeg")).toBeTruthy();
      expect(
        respBody.images[0].startsWith("s3://") &&
          respBody.images[0].endsWith(".jpeg")
      ).toBeTruthy();
      const s3Url = new URL(respBody.images[0]);
      const bucket = s3Url.hostname;
      const key = s3Url.pathname.slice(1);
      const s3Resp = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      const imageBuffer = Buffer.from(
        await s3Resp.Body!.transformToByteArray()
      );
      await checkImage(key, imageBuffer.toString("base64"));
    });

    it("text2image works with multiple images", async () => {
      const respBody = await submitPrompt(sd15Txt2ImgBatch4, false, undefined, {
        bucket: bucketName,
        prefix: "sd15-txt2img-batch4/",
        async: false,
      });
      expect(respBody.filenames.length).toEqual(4);
      expect(respBody.images.length).toEqual(4);
      for (let i = 0; i < respBody.filenames.length; i++) {
        expect(
          respBody.images[i].startsWith("s3://") &&
            respBody.images[i].endsWith(".png")
        ).toBeTruthy();
        const s3Url = new URL(respBody.images[i]);
        const bucket = s3Url.hostname;
        const key = s3Url.pathname.slice(1);
        const s3Resp = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        );
        const imageBuffer = Buffer.from(
          await s3Resp.Body!.transformToByteArray()
        );
        await checkImage(respBody.filenames[i], imageBuffer.toString("base64"));
      }
    });
  });

  describe("Upload to S3 Asynchronously", () => {
    it("text2image works with 1 image", async () => {
      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        bucket: bucketName,
        prefix: "sd15-txt2img-async/",
        async: true,
      });
      expect(respBody.status).toEqual("ok");

      const listCmd = new ListObjectsCommand({
        Bucket: bucketName,
        Prefix: "sd15-txt2img-async/",
      });

      let outputs: string[] = [];
      while (outputs.length < 1) {
        const page = await s3.send(listCmd);
        outputs = page.Contents?.map((obj) => obj.Key!) || [];
        if (outputs.length < 1) {
          await sleep(1000);
        }
      }

      expect(outputs.length).toEqual(1);
      const s3Resp = await s3.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: outputs[0],
        })
      );
      const imageBuffer = Buffer.from(
        await s3Resp.Body!.transformToByteArray()
      );
      await checkImage(outputs[0]!, imageBuffer.toString("base64"));
    });

    it("text2image works with multiple images", async () => {
      const respBody = await submitPrompt(sd15Txt2ImgBatch4, false, undefined, {
        bucket: bucketName,
        prefix: "sd15-txt2img-batch4-async/",
        async: true,
      });
      expect(respBody.status).toEqual("ok");

      const listCmd = new ListObjectsCommand({
        Bucket: bucketName,
        Prefix: "sd15-txt2img-batch4-async/",
      });

      let outputs: string[] = [];
      while (outputs.length < 4) {
        const page = await s3.send(listCmd);
        outputs = page.Contents?.map((obj) => obj.Key!) || [];

        if (outputs.length < 4) {
          await sleep(1000);
        }
      }

      expect(outputs.length).toEqual(4);
      for (const key of outputs) {
        const s3Resp = await s3.send(
          new GetObjectCommand({
            Bucket: bucketName,
            Key: key,
          })
        );
        const imageBuffer = Buffer.from(
          await s3Resp.Body!.transformToByteArray()
        );
        await checkImage(key!, imageBuffer.toString("base64"));
      }
    });
  });

  describe("Upload to Azure Blob and return Blob URL", () => {
    it("text2image works with 1 image", async () => {
      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        azure_blob_upload: {
          container: azureContainerName,
          blob_prefix: "sd15-txt2img/",
        },
      });
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      expect(
        respBody.images[0].includes(`/${azureContainerName}/sd15-txt2img/`) &&
          respBody.images[0].endsWith(".png")
      ).toBeTruthy();

      // Verify the image was uploaded to Azure Blob
      const azureUrl = respBody.images[0];
      const urlParts = new URL(azureUrl);
      let pathParts = urlParts.pathname.split("/").filter((p) => p);

      // For Azurite/emulator URLs in path-style format (http://host:port/accountname/container/blob)
      // vs Azure URLs in host-style format (https://accountname.blob.core.windows.net/container/blob)
      if (!urlParts.hostname.includes(".blob.core.windows.net")) {
        // Path-style URL - first part is account name, skip it
        pathParts = pathParts.slice(1);
      }

      const containerName = pathParts[0];
      const blobName = pathParts.slice(1).join("/");

      const azureContainer = await getAzureContainer(containerName);
      const blockBlobClient = azureContainer.getBlockBlobClient(blobName);
      const downloadResponse = await blockBlobClient.download();
      const imageBuffer = await streamToBuffer(
        downloadResponse.readableStreamBody!
      );
      await checkImage(respBody.filenames[0], imageBuffer.toString("base64"));
    });

    it("text2image works with multiple images", async () => {
      const respBody = await submitPrompt(sd15Txt2ImgBatch4, false, undefined, {
        azure_blob_upload: {
          container: azureContainerName,
          blob_prefix: "sd15-txt2img-batch4/",
        },
      });
      expect(respBody.filenames.length).toEqual(4);
      expect(respBody.images.length).toEqual(4);

      for (let i = 0; i < respBody.filenames.length; i++) {
        expect(
          respBody.images[i].includes(
            `/${azureContainerName}/sd15-txt2img-batch4/`
          ) && respBody.images[i].endsWith(".png")
        ).toBeTruthy();

        // Verify each image was uploaded to Azure Blob
        const azureUrl = respBody.images[i];
        const urlParts = new URL(azureUrl);
        let pathParts = urlParts.pathname.split("/").filter((p) => p);

        // For Azurite/emulator URLs in path-style format (http://host:port/accountname/container/blob)
        // vs Azure URLs in host-style format (https://accountname.blob.core.windows.net/container/blob)
        if (!urlParts.hostname.includes(".blob.core.windows.net")) {
          // Path-style URL - first part is account name, skip it
          pathParts = pathParts.slice(1);
        }

        const containerName = pathParts[0];
        const blobName = pathParts.slice(1).join("/");

        const azureContainer = await getAzureContainer(containerName);
        const blockBlobClient = azureContainer.getBlockBlobClient(blobName);
        const downloadResponse = await blockBlobClient.download();
        const imageBuffer = await streamToBuffer(
          downloadResponse.readableStreamBody!
        );
        await checkImage(respBody.filenames[i], imageBuffer.toString("base64"));
      }
    });
  });

  describe("Upload to HuggingFace and return HF URL", () => {
    it("text2image works with dataset repo", async () => {
      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        hf_upload: {
          repo: "SaladTechnologies/comfyui-api-integration-testing",
          repo_type: "dataset",
          directory: "test-outputs",
        },
      });
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      expect(
        respBody.images[0].startsWith(
          "https://huggingface.co/datasets/SaladTechnologies/comfyui-api-integration-testing/resolve/main/test-outputs/"
        ) && respBody.images[0].endsWith(".png")
      ).toBeTruthy();
    });

    it("text2image works with model repo", async () => {
      const respBody = await submitPrompt(sd15Txt2ImgBatch4, false, undefined, {
        hf_upload: {
          repo: "SaladTechnologies/comfyui-api-integration-testing",
          repo_type: "dataset",
          directory: "test-outputs-batch",
        },
      });
      expect(respBody.filenames.length).toEqual(4);
      expect(respBody.images.length).toEqual(4);
      for (let i = 0; i < respBody.filenames.length; i++) {
        expect(
          respBody.images[i].startsWith(
            "https://huggingface.co/datasets/SaladTechnologies/comfyui-api-integration-testing/resolve/main/test-outputs-batch/"
          ) && respBody.images[i].endsWith(".png")
        ).toBeTruthy();
      }
    });
  });

  describe("Upload to HuggingFace Asynchronously", () => {
    it("text2image works with 1 image", async () => {
      const timestamp = Date.now();
      const directory = `async-test-${timestamp}`;
      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        hf_upload: {
          repo: "SaladTechnologies/comfyui-api-integration-testing",
          repo_type: "dataset",
          directory,
          async: true,
        },
      });
      expect(respBody.status).toEqual("ok");

      // Poll HF repo for the uploaded file
      let fileExists = false;
      let attempts = 0;
      let fileUrl = "";

      while (!fileExists && attempts < 20) {
        // We need to check if any file exists in the directory
        // HF API endpoint for listing files: https://huggingface.co/api/datasets/{repo}/tree/{revision}/{path}
        const apiUrl = `https://huggingface.co/api/datasets/SaladTechnologies/comfyui-api-integration-testing/tree/main/${directory}`;

        try {
          const response = await fetch(apiUrl, {
            headers: {
              Authorization: `Bearer ${process.env.HF_TOKEN}`,
            },
          });

          if (response.ok) {
            const files = (await response.json()) as any[];
            if (files.length > 0) {
              fileExists = true;
              // Construct the file URL
              const fileName = files[0].path.split("/").pop();
              fileUrl = `https://huggingface.co/datasets/SaladTechnologies/comfyui-api-integration-testing/resolve/main/${directory}/${fileName}`;
            }
          }
        } catch (error) {
          // Directory might not exist yet
        }

        if (!fileExists) {
          await sleep(2000);
          attempts++;
        }
      }

      expect(fileExists).toBeTruthy();

      // Verify the file can be downloaded
      const downloadResponse = await fetch(fileUrl, {
        headers: {
          Authorization: `Bearer ${process.env.HF_TOKEN}`,
        },
      });
      expect(downloadResponse.ok).toBeTruthy();
    });

    it("text2image works with multiple images", async () => {
      const timestamp = Date.now();
      const directory = `async-batch-test-${timestamp}`;
      const respBody = await submitPrompt(sd15Txt2ImgBatch4, false, undefined, {
        hf_upload: {
          repo: "SaladTechnologies/comfyui-api-integration-testing",
          repo_type: "dataset",
          directory,
          async: true,
        },
      });
      expect(respBody.status).toEqual("ok");

      // Poll HF repo for the uploaded files
      let fileCount = 0;
      let attempts = 0;

      while (fileCount < 4 && attempts < 20) {
        const apiUrl = `https://huggingface.co/api/datasets/SaladTechnologies/comfyui-api-integration-testing/tree/main/${directory}`;

        try {
          const response = await fetch(apiUrl, {
            headers: {
              Authorization: `Bearer ${process.env.HF_TOKEN}`,
            },
          });

          if (response.ok) {
            const files = (await response.json()) as any[];
            fileCount = files.length;
          }
        } catch (error) {
          // Directory might not exist yet
        }

        if (fileCount < 4) {
          await sleep(2000);
          attempts++;
        }
      }

      expect(fileCount).toEqual(4);
    });
  });

  describe("Upload to Azure Blob Asynchronously", () => {
    it("text2image works with 1 image", async () => {
      // Use timestamp to make prefix unique per test run
      const timestamp = Date.now();
      const uniquePrefix = `sd15-txt2img-async-${timestamp}/`;

      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        azure_blob_upload: {
          container: azureContainerName,
          blob_prefix: uniquePrefix,
          async: true,
        },
      });
      expect(respBody.status).toEqual("ok");

      // Wait for async upload to complete
      const azureContainer = await getAzureContainer(azureContainerName);
      let blobs: string[] = [];
      let attempts = 0;
      while (blobs.length < 1 && attempts < 10) {
        blobs = [];
        for await (const blob of azureContainer.listBlobsFlat({
          prefix: uniquePrefix,
        })) {
          blobs.push(blob.name);
        }
        if (blobs.length < 1) {
          await sleep(1000);
        }
        attempts++;
      }

      expect(blobs.length).toEqual(1);

      // Verify the uploaded image
      const blockBlobClient = azureContainer.getBlockBlobClient(blobs[0]);
      const downloadResponse = await blockBlobClient.download();
      const imageBuffer = await streamToBuffer(
        downloadResponse.readableStreamBody!
      );
      await checkImage(blobs[0], imageBuffer.toString("base64"));
    });

    it("text2image works with multiple images", async () => {
      // Use timestamp to make prefix unique per test run
      const timestamp = Date.now();
      const uniquePrefix = `sd15-txt2img-batch4-async-${timestamp}/`;

      const respBody = await submitPrompt(sd15Txt2ImgBatch4, false, undefined, {
        azure_blob_upload: {
          container: azureContainerName,
          blob_prefix: uniquePrefix,
          async: true,
        },
      });
      expect(respBody.status).toEqual("ok");

      // Wait for async uploads to complete
      let blobs: string[] = [];
      let attempts = 0;
      while (blobs.length < 4 && attempts < 10) {
        await sleep(1000);
        blobs = [];
        const azureContainer = await getAzureContainer(azureContainerName);
        for await (const blob of azureContainer.listBlobsFlat({
          prefix: uniquePrefix,
        })) {
          blobs.push(blob.name);
        }
        attempts++;
      }

      expect(blobs.length).toEqual(4);

      // Verify each uploaded image
      for (const blobName of blobs) {
        const azureContainer = await getAzureContainer(azureContainerName);
        const blockBlobClient = azureContainer.getBlockBlobClient(blobName);
        const downloadResponse = await blockBlobClient.download();
        const imageBuffer = await streamToBuffer(
          downloadResponse.readableStreamBody!
        );
        await checkImage(blobName, imageBuffer.toString("base64"));
      }
    });
  });

  describe("Upload to HTTP file server and return HTTP URL", () => {
    it("text2image works with 1 image", async () => {
      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        http_upload: {
          url_prefix: "http://file-server:8080",
        },
      });
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      expect(
        respBody.images[0].startsWith("http://file-server:8080/") &&
          respBody.images[0].endsWith(".png")
      ).toBeTruthy();

      // Verify the image was uploaded to the HTTP server
      const httpUrl = respBody.images[0].replace("file-server", "localhost");
      const response = await fetch(httpUrl);
      expect(response.ok).toBeTruthy();
      const imageBuffer = Buffer.from(await response.arrayBuffer());
      await checkImage(respBody.filenames[0], imageBuffer.toString("base64"));
    });

    it("text2image works with multiple images", async () => {
      const respBody = await submitPrompt(sd15Txt2ImgBatch4, false, undefined, {
        http_upload: {
          url_prefix: "http://file-server:8080",
        },
      });
      expect(respBody.filenames.length).toEqual(4);
      expect(respBody.images.length).toEqual(4);

      for (let i = 0; i < respBody.filenames.length; i++) {
        expect(
          respBody.images[i].startsWith("http://file-server:8080/") &&
            respBody.images[i].endsWith(".png")
        ).toBeTruthy();

        // Verify each image was uploaded to the HTTP server
        const httpUrl = respBody.images[i].replace("file-server", "localhost");
        const response = await fetch(httpUrl);
        expect(response.ok).toBeTruthy();
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        await checkImage(respBody.filenames[i], imageBuffer.toString("base64"));
      }
    });
  });

  describe("Upload to HTTP file server Asynchronously", () => {
    it("text2image works with 1 image", async () => {
      const expectedPrefix = "http-async-txt2img-";
      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        http_upload: {
          url_prefix: `http://file-server:8080/${expectedPrefix}`,
          async: true,
        },
      });
      expect(respBody.status).toEqual("ok");

      // Wait for async upload to complete by polling the list endpoint
      let files: string[] = [];
      let attempts = 0;
      while (files.length < 1 && attempts < 10) {
        const listResp = await fetch(
          `http://localhost:8080/list?prefix=${expectedPrefix}`
        );
        const listData = (await listResp.json()) as { files?: string[] };
        files = listData.files || [];
        if (files.length < 1) {
          await sleep(1000);
        }
        attempts++;
      }

      expect(files.length).toEqual(1);

      // Verify the uploaded image
      const fileUrl = `http://localhost:8080/${files[0]}`;
      const response = await fetch(fileUrl);
      expect(response.ok).toBeTruthy();
      const imageBuffer = Buffer.from(await response.arrayBuffer());
      await checkImage(files[0], imageBuffer.toString("base64"));
    });

    it("text2image works with multiple images", async () => {
      const expectedPrefix = "http-async-batch4-";
      const respBody = await submitPrompt(sd15Txt2ImgBatch4, false, undefined, {
        http_upload: {
          url_prefix: `http://file-server:8080/${expectedPrefix}`,
          async: true,
        },
      });
      expect(respBody.status).toEqual("ok");

      // Wait for async uploads to complete by polling the list endpoint
      let files: string[] = [];
      let attempts = 0;
      while (files.length < 4 && attempts < 10) {
        const listResp = await fetch(
          `http://localhost:8080/list?prefix=${expectedPrefix}`
        );
        const listData = (await listResp.json()) as { files?: string[] };
        files = listData.files || [];
        if (files.length < 4) {
          await sleep(1000);
        }
        attempts++;
      }

      expect(files.length).toEqual(4);

      // Verify each uploaded image
      for (const filename of files) {
        const fileUrl = `http://localhost:8080/${filename}`;
        const response = await fetch(fileUrl);
        expect(response.ok).toBeTruthy();
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        await checkImage(filename, imageBuffer.toString("base64"));
      }
    });
  });

  describe("Workflow endpoints", () => {
    async function submitWorkflow(
      endpoint: string,
      inputs: any,
      webhook: boolean = false,
      convert: any = undefined,
      upload: any = undefined
    ): Promise<any> {
      const body: any = {
        input: inputs, // Wrap inputs in 'input' field as expected by workflow endpoint
      };
      if (webhook) {
        body["webhook"] = webhookAddress;
      }
      if (convert) {
        body["convert_output"] = convert;
      }
      if (upload) {
        // Handle different upload provider keys
        if (upload.bucket !== undefined || upload.prefix !== undefined) {
          body["s3"] = upload;
        } else {
          Object.assign(body, upload);
        }
      }

      const resp = await fetch(`http://localhost:3000${endpoint}`, {
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
        throw new Error(`Workflow submission failed: ${resp.status}`);
      }
      return await resp.json();
    }

    describe("/workflow/txt2img", () => {
      it("works with default parameters", async () => {
        const respBody = await submitWorkflow("/workflow/txt2img", {
          prompt: "a beautiful sunset",
          checkpoint: "dreamshaper_8.safetensors",
        });
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        await checkImage(respBody.filenames[0], respBody.images[0]);
      });

      it("works with custom parameters", async () => {
        const respBody = await submitWorkflow("/workflow/txt2img", {
          prompt: "a beautiful sunset",
          checkpoint: "dreamshaper_8.safetensors",
          seed: 42,
          steps: 20,
          cfg_scale: 7.5,
          width: 768,
          height: 768,
        });
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        await checkImage(respBody.filenames[0], respBody.images[0], {
          width: 768,
          height: 768,
        });
      });

      it("works with webhook", async () => {
        let expected = 1;
        const webhook = await createWebhookListener(async (body) => {
          expected--;
          const { id, filename, image } = body;
          expect(id).toEqual(reqId);
          await checkImage(filename, image);
        });

        const { id: reqId } = await submitWorkflow(
          "/workflow/txt2img",
          {
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
          },
          true
        );

        while (expected > 0) {
          await sleep(100);
        }
        await webhook.close();
      });

      it("works with S3 upload", async () => {
        const respBody = await submitWorkflow(
          "/workflow/txt2img",
          {
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
          },
          false,
          undefined,
          {
            bucket: bucketName,
            prefix: "workflow-txt2img/",
            async: false,
          }
        );
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        expect(
          respBody.images[0].startsWith("s3://") &&
            respBody.images[0].endsWith(".png")
        ).toBeTruthy();

        const s3Url = new URL(respBody.images[0]);
        const bucket = s3Url.hostname;
        const key = s3Url.pathname.slice(1);
        const s3Resp = await s3.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        );
        const imageBuffer = Buffer.from(
          await s3Resp.Body!.transformToByteArray()
        );
        await checkImage(key, imageBuffer.toString("base64"));
      });

      it("works with HuggingFace upload", async () => {
        const timestamp = Date.now();
        const respBody = await submitWorkflow(
          "/workflow/txt2img",
          {
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
          },
          false,
          undefined,
          {
            hf_upload: {
              repo: "SaladTechnologies/comfyui-api-integration-testing",
              repo_type: "dataset",
              directory: `workflow-txt2img-${timestamp}`,
            },
          }
        );
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        expect(
          respBody.images[0].startsWith(
            "https://huggingface.co/datasets/SaladTechnologies/comfyui-api-integration-testing/resolve/main/workflow-txt2img-"
          ) && respBody.images[0].endsWith(".png")
        ).toBeTruthy();
      });

      it("works with format conversion", async () => {
        const respBody = await submitWorkflow(
          "/workflow/txt2img",
          {
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
          },
          false,
          { format: "jpeg" }
        );
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        expect(respBody.filenames[0].endsWith(".jpeg")).toBeTruthy();
        await checkImage(respBody.filenames[0], respBody.images[0]);
      });
    });

    describe("/workflow/img2img", () => {
      it("works with base64 image", async () => {
        const respBody = await submitWorkflow("/workflow/img2img", {
          image: inputPngBase64,
          prompt: "a beautiful sunset",
          checkpoint: "dreamshaper_8.safetensors",
          width: 768,
          height: 768,
        });
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        await checkImage(respBody.filenames[0], respBody.images[0], {
          width: 768,
          height: 768,
        });
      });

      it("works with custom parameters", async () => {
        const respBody = await submitWorkflow("/workflow/img2img", {
          image: inputPngBase64,
          prompt: "a beautiful sunset",
          checkpoint: "dreamshaper_8.safetensors",
          seed: 42,
          steps: 20,
          cfg_scale: 7.5,
          denoise: 0.8,
          width: 768,
          height: 768,
        });
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        await checkImage(respBody.filenames[0], respBody.images[0], {
          width: 768,
          height: 768,
        });
      });

      it("works with HTTP image URL", async () => {
        const respBody = await submitWorkflow("/workflow/img2img", {
          image: `http://file-server:8080/${pngKey}`,
          prompt: "a beautiful sunset",
          checkpoint: "dreamshaper_8.safetensors",
          width: 768,
          height: 768,
        });
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        await checkImage(respBody.filenames[0], respBody.images[0], {
          width: 768,
          height: 768,
        });
      });

      it("works with S3 image URL", async () => {
        const respBody = await submitWorkflow("/workflow/img2img", {
          image: `s3://${bucketName}/${pngKey}`,
          prompt: "a beautiful sunset",
          checkpoint: "dreamshaper_8.safetensors",
          width: 768,
          height: 768,
        });
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        await checkImage(respBody.filenames[0], respBody.images[0], {
          width: 768,
          height: 768,
        });
      });

      it("works with Azure Blob image URL", async () => {
        const respBody = await submitWorkflow("/workflow/img2img", {
          image: `http://azurite:10000/devstoreaccount1/${azureContainerName}/${pngKey}`,
          prompt: "a beautiful sunset",
          checkpoint: "dreamshaper_8.safetensors",
          width: 768,
          height: 768,
        });
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        await checkImage(respBody.filenames[0], respBody.images[0], {
          width: 768,
          height: 768,
        });
      });

      it("works with webhook", async () => {
        let expected = 1;
        const webhook = await createWebhookListener(async (body) => {
          expected--;
          const { id, filename, image } = body;
          expect(id).toEqual(reqId);
          await checkImage(filename, image, {
            width: 768,
            height: 768,
          });
        });

        const { id: reqId } = await submitWorkflow(
          "/workflow/img2img",
          {
            image: inputPngBase64,
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
            width: 768,
            height: 768,
          },
          true
        );

        while (expected > 0) {
          await sleep(100);
        }
        await webhook.close();
      });

      it("works with Azure Blob upload", async () => {
        const respBody = await submitWorkflow(
          "/workflow/img2img",
          {
            image: inputPngBase64,
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
            width: 768,
            height: 768,
          },
          false,
          undefined,
          {
            azure_blob_upload: {
              container: azureContainerName,
              blob_prefix: "workflow-img2img/",
            },
          }
        );
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        expect(
          respBody.images[0].includes(
            `/${azureContainerName}/workflow-img2img/`
          ) && respBody.images[0].endsWith(".png")
        ).toBeTruthy();

        // Verify the image was uploaded
        const azureUrl = respBody.images[0];
        const urlParts = new URL(azureUrl);
        let pathParts = urlParts.pathname.split("/").filter((p) => p);
        if (!urlParts.hostname.includes(".blob.core.windows.net")) {
          pathParts = pathParts.slice(1);
        }
        const containerName = pathParts[0];
        const blobName = pathParts.slice(1).join("/");

        const azureContainer = await getAzureContainer(containerName);
        const blockBlobClient = azureContainer.getBlockBlobClient(blobName);
        const downloadResponse = await blockBlobClient.download();
        const imageBuffer = await streamToBuffer(
          downloadResponse.readableStreamBody!
        );
        await checkImage(
          respBody.filenames[0],
          imageBuffer.toString("base64"),
          {
            width: 768,
            height: 768,
          }
        );
      });

      it("works with HTTP file server upload", async () => {
        const respBody = await submitWorkflow(
          "/workflow/img2img",
          {
            image: inputPngBase64,
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
            width: 768,
            height: 768,
          },
          false,
          undefined,
          {
            http_upload: {
              url_prefix: "http://file-server:8080/workflow-img2img",
            },
          }
        );
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        expect(
          respBody.images[0].startsWith(
            "http://file-server:8080/workflow-img2img"
          ) && respBody.images[0].endsWith(".png")
        ).toBeTruthy();

        // Verify the image was uploaded
        const httpUrl = respBody.images[0].replace("file-server", "localhost");
        const response = await fetch(httpUrl);
        expect(response.ok).toBeTruthy();
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        await checkImage(
          respBody.filenames[0],
          imageBuffer.toString("base64"),
          {
            width: 768,
            height: 768,
          }
        );
      });

      it("works with HuggingFace upload", async () => {
        const timestamp = Date.now();
        const respBody = await submitWorkflow(
          "/workflow/img2img",
          {
            image: inputPngBase64,
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
            width: 768,
            height: 768,
          },
          false,
          undefined,
          {
            hf_upload: {
              repo: "SaladTechnologies/comfyui-api-integration-testing",
              repo_type: "dataset",
              directory: `workflow-img2img-${timestamp}`,
            },
          }
        );
        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);
        expect(
          respBody.images[0].startsWith(
            "https://huggingface.co/datasets/SaladTechnologies/comfyui-api-integration-testing/resolve/main/workflow-img2img-"
          ) && respBody.images[0].endsWith(".png")
        ).toBeTruthy();
      });

      it("works with async HuggingFace upload", async () => {
        const timestamp = Date.now();
        const directory = `workflow-txt2img-async-${timestamp}`;

        const respBody = await submitWorkflow(
          "/workflow/txt2img",
          {
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
          },
          false,
          undefined,
          {
            hf_upload: {
              repo: "SaladTechnologies/comfyui-api-integration-testing",
              repo_type: "dataset",
              directory,
              async: true,
            },
          }
        );
        expect(respBody.status).toEqual("ok");

        // Poll HF repo for the uploaded file
        let fileExists = false;
        let attempts = 0;

        while (!fileExists && attempts < 20) {
          const apiUrl = `https://huggingface.co/api/datasets/SaladTechnologies/comfyui-api-integration-testing/tree/main/${directory}`;

          try {
            const response = await fetch(apiUrl, {
              headers: {
                Authorization: `Bearer ${process.env.HF_TOKEN}`,
              },
            });

            if (response.ok) {
              const files = (await response.json()) as any[];
              if (files.length > 0) {
                fileExists = true;
              }
            }
          } catch (error) {
            // Directory might not exist yet
          }

          if (!fileExists) {
            await sleep(2000);
            attempts++;
          }
        }

        expect(fileExists).toBeTruthy();
      });

      it("works with async S3 upload", async () => {
        // Use a unique prefix to avoid picking up files from other tests
        const timestamp = Date.now();
        const uniquePrefix = `workflow-img2img-async-${timestamp}/`;

        const respBody = await submitWorkflow(
          "/workflow/img2img",
          {
            image: inputPngBase64,
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
            width: 768,
            height: 768,
          },
          false,
          undefined,
          {
            bucket: bucketName,
            prefix: uniquePrefix,
            async: true,
          }
        );
        expect(respBody.status).toEqual("ok");

        // Wait for async upload
        const listCmd = new ListObjectsCommand({
          Bucket: bucketName,
          Prefix: uniquePrefix,
        });

        let outputs: string[] = [];
        while (outputs.length < 1) {
          const page = await s3.send(listCmd);
          outputs = page.Contents?.map((obj) => obj.Key!) || [];
          if (outputs.length < 1) {
            await sleep(1000);
          }
        }

        expect(outputs.length).toEqual(1);
        const s3Resp = await s3.send(
          new GetObjectCommand({
            Bucket: bucketName,
            Key: outputs[0],
          })
        );
        const imageBuffer = Buffer.from(
          await s3Resp.Body!.transformToByteArray()
        );
        await checkImage(outputs[0]!, imageBuffer.toString("base64"), {
          width: 768,
          height: 768,
        });
      });

      it("works with async HuggingFace upload", async () => {
        const timestamp = Date.now();
        const directory = `workflow-img2img-async-hf-${timestamp}`;

        const respBody = await submitWorkflow(
          "/workflow/img2img",
          {
            image: inputPngBase64,
            prompt: "a beautiful sunset",
            checkpoint: "dreamshaper_8.safetensors",
            width: 768,
            height: 768,
          },
          false,
          undefined,
          {
            hf_upload: {
              repo: "SaladTechnologies/comfyui-api-integration-testing",
              repo_type: "dataset",
              directory,
              async: true,
            },
          }
        );
        expect(respBody.status).toEqual("ok");

        // Poll HF repo for the uploaded file
        let fileExists = false;
        let attempts = 0;

        while (!fileExists && attempts < 20) {
          const apiUrl = `https://huggingface.co/api/datasets/SaladTechnologies/comfyui-api-integration-testing/tree/main/${directory}`;

          try {
            const response = await fetch(apiUrl, {
              headers: {
                Authorization: `Bearer ${process.env.HF_TOKEN}`,
              },
            });

            if (response.ok) {
              const files = (await response.json()) as any[];
              if (files.length > 0) {
                fileExists = true;
              }
            }
          } catch (error) {
            // Directory might not exist yet
          }

          if (!fileExists) {
            await sleep(2000);
            attempts++;
          }
        }

        expect(fileExists).toBeTruthy();
      });

      it("image2image works with hf image url in model repo", async () => {
        // First, upload an image to HF model repo to use as source
        const timestamp = Date.now();
        const uploadResp = await submitPrompt(sd15Txt2Img, false, undefined, {
          hf_upload: {
            repo: "SaladTechnologies/comfyui-api-integration-testing",
            repo_type: "model",
            directory: `test-source-images-model-${timestamp}`,
          },
        });

        // Extract the URL of the uploaded image
        const hfImageUrl = uploadResp.images[0];

        // Now use this HF URL as input for img2img workflow
        const respBody = await submitWorkflow(
          "/workflow/img2img",
          {
            image: hfImageUrl,
            prompt: "a beautiful mountain landscape",
            checkpoint: "dreamshaper_8.safetensors",
            width: 768,
            height: 768,
          },
          false,
          undefined,
          {
            http_upload: {
              url_prefix: "http://file-server:8080/workflow-img2img-hf-source",
            },
          }
        );

        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);

        // Verify the transformed image was created
        const httpUrl = respBody.images[0].replace("file-server", "localhost");
        const response = await fetch(httpUrl);
        expect(response.ok).toBeTruthy();
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        await checkImage(
          respBody.filenames[0],
          imageBuffer.toString("base64"),
          {
            width: 768,
            height: 768,
          }
        );
      });

      it("image2image works with hf image url in dataset repo", async () => {
        // First, upload an image to HF dataset repo to use as source
        const timestamp = Date.now();
        const uploadResp = await submitPrompt(sd15Txt2Img, false, undefined, {
          hf_upload: {
            repo: "SaladTechnologies/comfyui-api-integration-testing",
            repo_type: "dataset",
            directory: `test-source-images-dataset-${timestamp}`,
          },
        });

        // Extract the URL of the uploaded image
        const hfImageUrl = uploadResp.images[0];

        // Now use this HF URL as input for img2img workflow
        const respBody = await submitWorkflow(
          "/workflow/img2img",
          {
            image: hfImageUrl,
            prompt: "a futuristic cityscape",
            checkpoint: "dreamshaper_8.safetensors",
            width: 768,
            height: 768,
          },
          false,
          undefined,
          {
            http_upload: {
              url_prefix:
                "http://file-server:8080/workflow-img2img-hf-dataset-source",
            },
          }
        );

        expect(respBody.filenames.length).toEqual(1);
        expect(respBody.images.length).toEqual(1);

        // Verify the transformed image was created
        const httpUrl = respBody.images[0].replace("file-server", "localhost");
        const response = await fetch(httpUrl);
        expect(response.ok).toBeTruthy();
        const imageBuffer = Buffer.from(await response.arrayBuffer());
        await checkImage(
          respBody.filenames[0],
          imageBuffer.toString("base64"),
          {
            width: 768,
            height: 768,
          }
        );
      });
    });
  });
});

describe("Download Endpoint", () => {
  const testModelFilename = "test-model.safetensors";
  const testModelUrl = `http://file-server:8080/${testModelFilename}`;

  before(async () => {
    await waitForServerToBeReady();
    // Seed the HTTP file server with a test "model" file
    const testModelContent = Buffer.from("fake model content for testing");
    await fetch(`http://localhost:8080/${testModelFilename}`, {
      method: "PUT",
      body: testModelContent,
      headers: {
        "Content-Type": "application/octet-stream",
      },
    });
  });

  async function submitDownload(body: {
    url: string;
    model_type: string;
    filename?: string;
    wait?: boolean;
  }): Promise<{ status: number; body: any }> {
    const resp = await fetch(`http://localhost:3000/download`, {
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
    return {
      status: resp.status,
      body: await resp.json(),
    };
  }

  describe("Async download (wait: false)", () => {
    it("returns 202 immediately with status 'started'", async () => {
      const { status, body } = await submitDownload({
        url: testModelUrl,
        model_type: "checkpoints",
        filename: `async-test-${Date.now()}.safetensors`,
        wait: false,
      });

      expect(status).toEqual(202);
      expect(body.status).toEqual("started");
      expect(body.url).toEqual(testModelUrl);
      expect(body.model_type).toEqual("checkpoints");
      expect(typeof body.filename).toEqual("string");
      // Async response should not include size or duration
      expect(body.size).toEqual(undefined);
      expect(body.duration).toEqual(undefined);
    });

    it("defaults to async when wait is not specified", async () => {
      const { status, body } = await submitDownload({
        url: testModelUrl,
        model_type: "checkpoints",
        filename: `async-default-${Date.now()}.safetensors`,
      });

      expect(status).toEqual(202);
      expect(body.status).toEqual("started");
    });
  });

  describe("Sync download (wait: true)", () => {
    it("returns 200 with status 'completed', size, and duration", async () => {
      const { status, body } = await submitDownload({
        url: testModelUrl,
        model_type: "checkpoints",
        filename: `sync-test-${Date.now()}.safetensors`,
        wait: true,
      });

      expect(status).toEqual(200);
      expect(body.status).toEqual("completed");
      expect(body.url).toEqual(testModelUrl);
      expect(body.model_type).toEqual("checkpoints");
      expect(typeof body.filename).toEqual("string");
      expect(body.size).toBeGreaterThan(0);
      expect(body.duration).toBeGreaterThanOrEqual(0);
    });

    it("extracts filename from URL when not provided", async () => {
      const { status, body } = await submitDownload({
        url: testModelUrl,
        model_type: "checkpoints",
        wait: true,
      });

      expect(status).toEqual(200);
      expect(body.filename).toEqual(testModelFilename);
    });
  });

  describe("Error handling", () => {
    it("returns 400 for invalid model_type", async () => {
      const { status } = await submitDownload({
        url: testModelUrl,
        model_type: "invalid_model_type_that_does_not_exist",
        wait: true,
      });

      expect(status).toEqual(400);
    });

    it("returns 400 for invalid URL", async () => {
      const { status, body } = await submitDownload({
        url: "not-a-valid-url",
        model_type: "checkpoints",
        wait: true,
      });

      expect(status).toEqual(400);
      expect(typeof body.error).toEqual("string");
    });

    it("returns 400 for download failure (non-existent file)", async () => {
      const { status, body } = await submitDownload({
        url: "http://file-server:8080/non-existent-file.safetensors",
        model_type: "checkpoints",
        wait: true,
      });

      expect(status).toEqual(400);
      expect(typeof body.error).toEqual("string");
    });
  });

  describe("Different model types", () => {
    it("works with loras model type", async () => {
      const { status, body } = await submitDownload({
        url: testModelUrl,
        model_type: "loras",
        filename: `lora-test-${Date.now()}.safetensors`,
        wait: true,
      });

      expect(status).toEqual(200);
      expect(body.status).toEqual("completed");
      expect(body.model_type).toEqual("loras");
    });
  });
});

describe("System Events", () => {
  before(async () => {
    await waitForServerToBeReady();
  });

  it("works", async () => {
    const uniquePrompt = JSON.parse(JSON.stringify(sd15Txt2Img));
    uniquePrompt["3"].inputs.seed = Math.floor(Math.random() * 1000000);
    const eventsReceived: { [key: string]: number } = {};
    const webhook = await createWebhookListener((body) => {
      if (body?.data?.data?.prompt_id !== promptId) {
        // Ignore events from other prompts
        return;
      }
      if (!eventsReceived[body.event]) {
        eventsReceived[body.event] = 0;
      }
      eventsReceived[body.event]++;
    }, "/system");

    const { id: promptId } = await submitPrompt(uniquePrompt);
    let attempts = 100;
    while (
      !(
        eventsReceived["comfy.execution_success"] &&
        eventsReceived["comfy.executed"] &&
        eventsReceived["comfy.progress"]
      ) &&
      attempts > 0
    ) {
      await sleep(100);
      attempts--;
    }

    await webhook.close();

    expect(eventsReceived["comfy.executed"]).toEqual(1);
    expect(eventsReceived["comfy.execution_success"]).toEqual(1);
    expect(eventsReceived["comfy.progress"]).toBeGreaterThan(0);
  });
});
