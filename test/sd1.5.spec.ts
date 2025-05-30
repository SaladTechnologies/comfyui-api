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

      const outputs = [];
      while (outputs.length < 1) {
        const page = await s3.send(listCmd);
        for (const obj of page.Contents || []) {
          outputs.push(obj.Key);
        }
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
});
