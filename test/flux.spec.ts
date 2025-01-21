import { expect } from "earl";
import {
  sleep,
  createWebhookListener,
  submitPrompt,
  checkImage,
  waitForServerToBeReady,
} from "./test-utils";
import fluxTxt2Img from "./workflows/flux-txt2img.json";

const fluxOpts = {
  width: fluxTxt2Img["27"].inputs.width,
  height: fluxTxt2Img["27"].inputs.height,
};

describe("Flux", () => {
  before(async () => {
    await waitForServerToBeReady();
  });
  describe("Return content in response", () => {
    it("text2image works with 1 image", async () => {
      const respBody = await submitPrompt(fluxTxt2Img);
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], fluxOpts);
    });
  });

  describe("Return content in webhook", () => {
    it("text2image works with 1 image", async () => {
      let expected = 1;
      const webhook = await createWebhookListener(async (body) => {
        expected--;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image, fluxOpts);
      });
      const { id: reqId } = await submitPrompt(fluxTxt2Img, true);
      while (expected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });
  });
});
