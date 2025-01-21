import { expect } from "earl";
import {
  sleep,
  createWebhookListener,
  submitPrompt,
  checkImage,
  waitForServerToBeReady,
} from "./test-utils";
import txt2Video from "./workflows/cosmos1.0-7b-txt2video.json";

const text2VideoOptions = {
  webpFrames: 41,
  width: txt2Video["78"].inputs.width,
  height: txt2Video["78"].inputs.height,
};

describe("Cosmos 1.0 7b", () => {
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
  });
});
