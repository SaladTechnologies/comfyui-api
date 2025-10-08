import { expect } from "earl";
import path from "path";
import fs from "fs";
import {
  sleep,
  createWebhookListener,
  submitPrompt,
  checkImage,
  waitForServerToBeReady,
  s3,
  getAzureContainer,
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

    it("image2image works with hf image url", async () => {});

    it("works if the workflow has multiple output nodes", async () => {
      const respBody = await submitPrompt(sd15MultiOutput);
      expect(respBody.filenames.length).toEqual(2);
      expect(respBody.images.length).toEqual(2);
    });

    it("works if there are 2 parallel, non-interrelated workflows", async () => {
      const respBody = await submitPrompt(sd15Parallel2);
      expect(respBody.filenames.length).toEqual(2);
      expect(respBody.images.length).toEqual(2);
    });

    it("works if there are 3 parallel, non-interrelated workflows", async () => {
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
        azureBlobUpload: {
          container: azureContainerName,
          blobPrefix: "sd15-txt2img/",
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
        azureBlobUpload: {
          container: azureContainerName,
          blobPrefix: "sd15-txt2img-batch4/",
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

  describe("Upload to Azure Blob Asynchronously", () => {
    it("text2image works with 1 image", async () => {
      // Use timestamp to make prefix unique per test run
      const timestamp = Date.now();
      const uniquePrefix = `sd15-txt2img-async-${timestamp}/`;

      const respBody = await submitPrompt(sd15Txt2Img, false, undefined, {
        azureBlobUpload: {
          container: azureContainerName,
          blobPrefix: uniquePrefix,
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
        azureBlobUpload: {
          container: azureContainerName,
          blobPrefix: uniquePrefix,
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
        httpUpload: {
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
        httpUpload: {
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
        httpUpload: {
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
        const listData = await listResp.json();
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
        httpUpload: {
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
        const listData = await listResp.json();
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
});
