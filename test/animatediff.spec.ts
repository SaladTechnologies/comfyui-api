import { expect } from "earl";
import sharp from "sharp";

import animateDiffLargeVideo from "./workflows/animatediff-large-video-and-frames.json";
import animateDiffSmallVideo from "./workflows/animatediff-small-video.json";
import animateDiffSmallVideoAndFrames from "./workflows/animatediff-small-video-and-frames.json";
import animateDiffSmallFrames from "./workflows/animatediff-small-frames.json";

describe("AnimateDiff", () => {
  describe("Return content in response", () => {
    it("returns still frames and a video", async () => {
      const resp = await fetch(`http://localhost:3000/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: animateDiffSmallVideoAndFrames }),
      });
      expect(resp.ok).toEqual(true);

      const respBody = await resp.json();
      expect(respBody.filenames.length).toEqual(11);
      for (let i = 0; i < respBody.filenames.length; i++) {
        const filename = respBody.filenames[i];
        const image = sharp(Buffer.from(respBody.images[i], "base64"));
        const metadata = await image.metadata();
        expect(metadata.width).toEqual(512);
        expect(metadata.height).toEqual(512);
        if (filename.endsWith(".webp")) {
          expect(metadata.format).toEqual("webp");
          expect(metadata.pages).toEqual(10);
        }
      }
    });

    it("returns just a video", async () => {
      const resp = await fetch(`http://localhost:3000/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: animateDiffSmallVideo }),
      });
      expect(resp.ok).toEqual(true);

      const respBody = await resp.json();
      expect(respBody.filenames.length).toEqual(1);
      expect(respBody.filenames[0]).toMatchRegex(/\.webp$/);

      expect(respBody.images.length).toEqual(1);
      const imageBuffer = Buffer.from(respBody.images[0], "base64");
      const image = sharp(imageBuffer);
      const metadata = await image.metadata();
      expect(metadata.width).toEqual(512);
      expect(metadata.height).toEqual(512);
      expect(metadata.format).toEqual("webp");
      expect(metadata.pages).toEqual(10);
    });

    it("returns just still frames", async () => {
      const resp = await fetch(`http://localhost:3000/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: animateDiffSmallFrames }),
      });
      expect(resp.ok).toEqual(true);

      const respBody = await resp.json();
      expect(respBody.filenames.length).toEqual(10);
      for (let i = 0; i < respBody.filenames.length; i++) {
        const image = sharp(Buffer.from(respBody.images[i], "base64"));
        const metadata = await image.metadata();
        expect(metadata.width).toEqual(512);
        expect(metadata.height).toEqual(512);
        expect(metadata.format).toEqual("png");
      }
    });

    it("accepts an array of base64 encoded images in the directory field");

    it("handles multiple queued requests");

    it("handles large numbers of outputs", async () => {
      const resp = await fetch(`http://localhost:3000/prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: animateDiffLargeVideo }),
      });
      expect(resp.ok).toEqual(true);
      const respBody = await resp.json();
      expect(respBody.filenames.length).toEqual(73);
      for (let i = 0; i < respBody.filenames.length; i++) {
        const filename = respBody.filenames[i];
        const image = sharp(Buffer.from(respBody.images[i], "base64"));
        const metadata = await image.metadata();
        expect(metadata.width).toEqual(512);
        expect(metadata.height).toEqual(512);
        if (filename.endsWith(".webp")) {
          expect(metadata.format).toEqual("webp");
          expect(metadata.pages).toEqual(72);
        }
      }
    });
  });

  describe("Return content in webhooks", () => {
    it("returns still frames and a video");
    it("returns just a video");
    it("returns just still frames");
  });
});
