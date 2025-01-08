import { expect } from "earl";
import path from "path";
import fs from "fs";
import {
  sleep,
  createWebhookListener,
  submitPrompt,
  checkImage,
  waitForServerToStart,
} from "./test-utils";
import sdxlWithRefinerTxt2Img from "./workflows/sdxl-with-refiner.json";

const txt2imgOpts = {
  width: sdxlWithRefinerTxt2Img["5"].inputs.width,
  height: sdxlWithRefinerTxt2Img["5"].inputs.height,
};

describe("Stable Diffusion XL", () => {
  before(async () => {
    await waitForServerToStart();
  });
  describe("Return content in response", () => {
    it("text2image works with 1 image", async () => {
      const respBody = await submitPrompt(sdxlWithRefinerTxt2Img);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], txt2imgOpts);
    });
  });

  describe("Return content in webhook", () => {
    it("text2image works with 1 image", async () => {
      let expected = 1;
      const webhook = await createWebhookListener(async (body) => {
        expected--;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image, txt2imgOpts);
      });
      /**
       * TODO: There is some kind of race condition here I can't figure out. It doesn't seem to effect
       * most other webhook tests, but it does seem to effect this one. comfyui-api logs report that it got no response
       * from the webhook if this value is smaller.
       * */
      await sleep(700);
      const { id: reqId } = await submitPrompt(sdxlWithRefinerTxt2Img, true);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });
  });
});
