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
import txt2Video from "./workflows/ltxv_text_to_video.json";
import img2Video from "./workflows/ltxv_image_to_video.json";

const inputImage = fs
  .readFileSync(path.join(__dirname, "input-images", "beach-tree.png"))
  .toString("base64");
img2Video["78"].inputs.image = inputImage;

const text2VideoOptions = {
  webpFrames: 9,
  width: txt2Video["70"].inputs.width,
  height: txt2Video["70"].inputs.height,
};
const img2VideoOptions = {
  webpFrames: 9,
  width: img2Video["77"].inputs.width,
  height: img2Video["77"].inputs.height,
};

describe("LTX Video", () => {
  before(async () => {
    await waitForServerToBeReady();
  });
  describe("Return content in response", () => {
    it("text2video works", async () => {
      const respBody = await submitPrompt(txt2Video);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(
        respBody.filenames[0],
        respBody.images[0],
        text2VideoOptions
      );
    });

    it("image2video works with base64 encoded images", async () => {
      const respBody = await submitPrompt(img2Video);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(
        respBody.filenames[0],
        respBody.images[0],
        img2VideoOptions
      );
    });
  });

  describe("Return content in webhook", () => {
    it("text2video works", async () => {
      let expected = 1;
      const webhook = await createWebhookListener(async (body) => {
        expected--;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image, text2VideoOptions);
      });
      const { id: reqId } = await submitPrompt(txt2Video, true);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });

    it("image2video works with base64 encoded images", async () => {
      let expected = 1;
      const webhook = await createWebhookListener(async (body) => {
        expected--;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image, img2VideoOptions);
      });
      const { id: reqId } = await submitPrompt(img2Video, true);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });
  });
});
