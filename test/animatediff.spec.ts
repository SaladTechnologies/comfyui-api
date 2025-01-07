import { expect } from "earl";
import sharp from "sharp";

import animateDiffLargeVideo from "./workflows/animatediff-large-video-and-frames.json";
import animateDiffSmallVideo from "./workflows/animatediff-small-video.json";
import animateDiffSmallVideoAndFrames from "./workflows/animatediff-small-video-and-frames.json";
import animateDiffSmallFrames from "./workflows/animatediff-small-frames.json";
import path from "path";
import fs from "fs/promises";

async function submitPromptSync(prompt: any) {
  const resp = await fetch(`http://localhost:3000/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });
  expect(resp.ok).toEqual(true);
  return await resp.json();
}

async function checkImage(
  filename: string,
  imageB64: string,
  webpFrames = 10
): Promise<void> {
  const image = sharp(Buffer.from(imageB64, "base64"));
  const metadata = await image.metadata();
  expect(metadata.width).toEqual(512);
  expect(metadata.height).toEqual(512);
  if (filename.endsWith(".webp")) {
    expect(metadata.format).toEqual("webp");
    expect(metadata.pages).toEqual(webpFrames);
  } else if (filename.endsWith(".png")) {
    expect(metadata.format).toEqual("png");
  }
}

describe("AnimateDiff", () => {
  describe("Return content in response", () => {
    it("returns still frames and a video", async () => {
      const respBody = await submitPromptSync(animateDiffSmallVideoAndFrames);

      expect(respBody.filenames.length).toEqual(11);
      for (let i = 0; i < respBody.filenames.length; i++) {
        await checkImage(respBody.filenames[i], respBody.images[i], 10);
      }
    });

    it("returns just a video", async () => {
      const respBody = await submitPromptSync(animateDiffSmallVideo);

      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.filenames[0]).toMatchRegex(/\.webp$/);

      expect(respBody.images.length).toEqual(1);
      await checkImage(respBody.filenames[0], respBody.images[0], 10);
    });

    it("returns just still frames", async () => {
      const respBody = await submitPromptSync(animateDiffSmallFrames);
      expect(respBody.filenames.length).toEqual(10);
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

      const respBody = await submitPromptSync(modifiedPrompt);
      expect(respBody.filenames.length).toEqual(10);
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
        submitPromptSync(animateDiffSmallFrames),
        submitPromptSync(withDiffSeed),
      ]);

      expect(resp1.filenames.length).toEqual(10);
      for (let i = 0; i < resp1.filenames.length; i++) {
        await checkImage(resp1.filenames[i], resp1.images[i]);
      }

      expect(resp2.filenames.length).toEqual(10);
      for (let i = 0; i < resp2.filenames.length; i++) {
        await checkImage(resp2.filenames[i], resp2.images[i]);
      }
    });

    it("handles large numbers of outputs", async () => {
      const respBody = await submitPromptSync(animateDiffLargeVideo);
      expect(respBody.filenames.length).toEqual(73);
      for (let i = 0; i < respBody.filenames.length; i++) {
        await checkImage(respBody.filenames[i], respBody.images[i], 72);
      }
    });
  });

  describe("Return content in webhooks", () => {
    it("returns still frames and a video");
    it("returns just a video");
    it("returns just still frames");
  });
});
