import { expect } from "earl";
import animateDiffLargeVideo from "./workflows/animatediff-large-video-and-frames.json";
import animateDiffSmallVideo from "./workflows/animatediff-small-video.json";
import animateDiffSmallVideoAndFrames from "./workflows/animatediff-small-video-and-frames.json";
import animateDiffSmallFrames from "./workflows/animatediff-small-frames.json";
import path from "path";
import fs from "fs/promises";
import {
  sleep,
  createWebhookListener,
  submitPrompt,
  checkImage,
  waitForServerToBeReady,
} from "./test-utils";
import { before } from "mocha";

const shortOpts = {
  width: animateDiffSmallVideo["70"].inputs.width,
  height: animateDiffSmallVideo["70"].inputs.height,
  webpFrames: animateDiffSmallVideo["52"].inputs.image_load_cap,
};

const largeOpts = {
  width: animateDiffLargeVideo["24"].inputs.width,
  height: animateDiffLargeVideo["24"].inputs.height,
  webpFrames: 72,
};

describe("AnimateDiff", () => {
  before(async () => {
    await waitForServerToBeReady();
  });
  describe("Return content in response", () => {
    it("returns still frames and a video", async () => {
      const respBody = await submitPrompt(animateDiffSmallVideoAndFrames);

      expect(respBody.filenames.length).toEqual(11);
      for (let i = 0; i < respBody.filenames.length; i++) {
        await checkImage(respBody.filenames[i], respBody.images[i], shortOpts);
      }
    });

    it("returns just a video", async () => {
      const respBody = await submitPrompt(animateDiffSmallVideo);

      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.filenames[0]).toMatchRegex(/\.webp$/);

      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], shortOpts);
    });

    it("returns just still frames", async () => {
      const respBody = await submitPrompt(animateDiffSmallFrames);
      expect(respBody.filenames.length).toEqual(shortOpts.webpFrames);
      for (let i = 0; i < respBody.filenames.length; i++) {
        await checkImage(respBody.filenames[i], respBody.images[i]);
      }
    });

    it("accepts an array of base64 encoded images in the directory field", async () => {
      const poseDir = path.join(__dirname, "docker-image", "poses");
      const poseFiles = await fs.readdir(poseDir);
      const poseImages = await Promise.all(
        poseFiles.map(async (f) => {
          const imgBuffer = await fs.readFile(path.join(poseDir, f));
          return imgBuffer.toString("base64");
        })
      );
      const modifiedPrompt = JSON.parse(JSON.stringify(animateDiffSmallFrames));
      for (let nodeId in modifiedPrompt) {
        if (modifiedPrompt[nodeId].inputs.directory) {
          modifiedPrompt[nodeId].inputs.directory = poseImages;
        }
      }

      const respBody = await submitPrompt(modifiedPrompt);
      expect(respBody.filenames.length).toEqual(shortOpts.webpFrames);
      for (let i = 0; i < respBody.filenames.length; i++) {
        await checkImage(respBody.filenames[i], respBody.images[i]);
      }
    });

    it("handles multiple queued requests", async () => {
      const withDiffSeed = JSON.parse(JSON.stringify(animateDiffSmallFrames));
      for (let nodeId in withDiffSeed) {
        if (withDiffSeed[nodeId].inputs.seed) {
          withDiffSeed[nodeId].inputs.seed += 1;
        }
      }
      const [resp1, resp2] = await Promise.all([
        submitPrompt(animateDiffSmallFrames),
        submitPrompt(withDiffSeed),
      ]);

      expect(resp1.filenames.length).toEqual(shortOpts.webpFrames);
      for (let i = 0; i < resp1.filenames.length; i++) {
        await checkImage(resp1.filenames[i], resp1.images[i]);
      }

      expect(resp2.filenames.length).toEqual(shortOpts.webpFrames);
      for (let i = 0; i < resp2.filenames.length; i++) {
        await checkImage(resp2.filenames[i], resp2.images[i]);
      }
    });

    it("handles large numbers of outputs", async () => {
      const respBody = await submitPrompt(animateDiffLargeVideo);
      expect(respBody.filenames.length).toEqual(largeOpts.webpFrames + 1);
      for (let i = 0; i < respBody.filenames.length; i++) {
        await checkImage(respBody.filenames[i], respBody.images[i], largeOpts);
      }
    });
  });

  describe("Return content in webhooks", () => {
    it("returns still frames and a video", async () => {
      let numExpected = 11;
      const webhook = await createWebhookListener(async (body) => {
        numExpected -= 1;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image, shortOpts);
      });
      const respBody = await submitPrompt(animateDiffSmallVideoAndFrames, true);
      const { id: reqId } = respBody;

      while (numExpected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });
    it("returns just a video", async () => {
      let numExpected = 1;
      const webhook = await createWebhookListener(async (body) => {
        numExpected -= 1;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image, shortOpts);
      });
      const respBody = await submitPrompt(animateDiffSmallVideo, true);
      const { id: reqId } = respBody;

      while (numExpected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });
    it("returns just still frames", async () => {
      let numExpected = 10;
      const webhook = await createWebhookListener(async (body) => {
        numExpected -= 1;
        const { id, filename, image } = body;
        expect(id).toEqual(reqId);
        await checkImage(filename, image);
      });
      const respBody = await submitPrompt(animateDiffSmallFrames, true);
      const { id: reqId } = respBody;

      while (numExpected > 0) {
        await sleep(100);
      }
      await webhook.close();
    });
  });
});
