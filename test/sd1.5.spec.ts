import { expect } from "earl";
import path from "path";
import fs from "fs";
import {
  sleep,
  createWebhookListener,
  submitPrompt,
  checkImage,
  waitForServerToBeReady,
} from "./test-utils";
import sd15Txt2Img from "./workflows/sd1.5-txt2img.json";
import sd15Img2Img from "./workflows/sd1.5-img2img.json";

const sd15Txt2ImgBatch4 = JSON.parse(JSON.stringify(sd15Txt2Img));
sd15Txt2ImgBatch4["5"].inputs.batch_size = 4;

const inputImage = fs
  .readFileSync(path.join(__dirname, "input-images", "doodle-girl.png"))
  .toString("base64");
sd15Img2Img["10"].inputs.image = inputImage;

describe("Stable Diffusion 1.5", () => {
  before(async () => {
    await waitForServerToBeReady();
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

    it("image2image works with base64 encoded images", async () => {
      const respBody = await submitPrompt(sd15Img2Img);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], {
        width: 768,
        height: 768,
      });
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
});
