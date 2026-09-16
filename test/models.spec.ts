import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../src/config", () => ({
  default: {
    apiVersion: "1.19.1",
    logLevel: "silent",
    maxBodySize: 1024 * 1024,
    wrapperPort: 3000,
    comfyDir: "/unused/comfyui",
    // Older directories still exist on disk in current ComfyUI images.
    models: { checkpoints: {}, clip: {}, unet: {} },
  },
}));
vi.mock("../src/comfy", () => ({ getModels: vi.fn() }));
vi.mock("../src/remote-storage-manager", () => ({
  default: () => ({ storageProviders: [] }),
}));
vi.mock("../src/workflows", () => ({ default: {} }));

import { getModels } from "../src/comfy";
import { server } from "../src/server";

function availableModels(models: Record<string, string[]>) {
  vi.mocked(getModels).mockResolvedValueOnce(
    Object.fromEntries(
      Object.entries(models).map(([type, all]) => [
        type,
        {
          dir: `/unused/comfyui/models/${type}`,
          all,
          enum: z.enum(all as [string, ...string[]]),
        },
      ])
    )
  );
}

beforeEach(() => {
  vi.mocked(getModels).mockReset();
});

afterAll(async () => {
  await server.close();
});

describe("GET /models", () => {
  it("returns current ComfyUI categories without requiring legacy directories", async () => {
    const models = {
      checkpoints: ["dreamshaper_8.safetensors"],
      text_encoders: ["clip_l.safetensors"],
      diffusion_models: ["flux.safetensors"],
      vae: [],
    };
    availableModels(models);

    const response = await server.inject({ method: "GET", url: "/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(models);
  });

  it("preserves legacy categories when reported by an older ComfyUI", async () => {
    const models = {
      checkpoints: [],
      clip: ["clip_l.safetensors"],
      unet: ["model.safetensors"],
    };
    availableModels(models);

    const response = await server.inject({ method: "GET", url: "/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(models);
  });

  it("includes categories and files discovered after earlier requests", async () => {
    const initial = { checkpoints: [], clip: [], unet: [] };
    availableModels(initial);
    const first = await server.inject({ method: "GET", url: "/models" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual(initial);

    const updated = {
      ...initial,
      checkpoints: ["downloaded.safetensors"],
      custom_models: ["custom.bin"],
    };
    availableModels(updated);
    const second = await server.inject({ method: "GET", url: "/models" });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(updated);
  });

  it("returns an empty object when ComfyUI reports no model categories", async () => {
    availableModels({});

    const response = await server.inject({ method: "GET", url: "/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
  });

  it("documents model categories as a map of filename arrays", async () => {
    const response = await server.inject({ method: "GET", url: "/docs/json" });

    expect(response.statusCode, response.body).toBe(200);
    const schema = response.json().paths["/models"].get.responses["200"]
      .content["application/json"].schema;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } },
    });
    expect(schema.required).toBeUndefined();
  });
});
