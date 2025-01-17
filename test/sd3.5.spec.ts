import { expect } from "earl";

import {
  sleep,
  createWebhookListener,
  submitPrompt,
  checkImage,
  waitForServerToBeReady,
} from "./test-utils";
import sd35Txt2Image from "./workflows/sd3.5-txt2img.json";

const txt2imgOpts = {
  width: sd35Txt2Image["135"].inputs.width,
  height: sd35Txt2Image["135"].inputs.height,
};

describe("Stable Diffusion 3.5", () => {
  before(async () => {
    await waitForServerToBeReady();
  });
  describe("Return content in response", () => {
    it("text2image works with 1 image", async () => {
      const respBody = await submitPrompt(sd35Txt2Image);
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
      const { id: reqId } = await submitPrompt(sd35Txt2Image, true);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });
  });
});
