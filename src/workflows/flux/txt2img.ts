import { z } from "zod";
import { ComfyNode, Workflow } from "../../types";

const RequestSchema = z.object({
  positivePrompt: z.string(),
  width: z.number().int().min(256).max(1024).optional().default(1024),
  height: z.number().int().min(256).max(1024).optional().default(1024),
  seed: z
    .number()
    .int()
    .optional()
    .default(() => Math.floor(Math.random() * 100000)),
  steps: z.number().int().min(1).max(10).optional().default(4),
  sampler: z.enum(["euler"]).optional().default("euler"), // This may need to be expanded with more options
  scheduler: z.enum(["simple"]).optional().default("simple"), // This may need to be expanded with more options
  checkpoint: z
    .enum(["flux1-schnell-fp8.safetensors"])
    .optional()
    .default("flux1-schnell-fp8.safetensors"), // This may need to be expanded with more options
});

type Input = z.infer<typeof RequestSchema>;

export function generateWorkflow(input: Input): Record<string, ComfyNode> {
  return {
    "6": {
      inputs: {
        text: input.positivePrompt,
        clip: ["30", 1],
      },
      class_type: "CLIPTextEncode",
      _meta: {
        title: "CLIP Text Encode (Positive Prompt)",
      },
    },
    "8": {
      inputs: {
        samples: ["31", 0],
        vae: ["30", 2],
      },
      class_type: "VAEDecode",
      _meta: {
        title: "VAE Decode",
      },
    },
    "9": {
      inputs: {
        filename_prefix: "",
        images: ["8", 0],
      },
      class_type: "SaveImage",
      _meta: {
        title: "Save Image",
      },
    },
    "27": {
      inputs: {
        width: input.width,
        height: input.height,
        batch_size: 1,
      },
      class_type: "EmptySD3LatentImage",
      _meta: {
        title: "EmptySD3LatentImage",
      },
    },
    "30": {
      inputs: {
        ckpt_name: input.checkpoint,
      },
      class_type: "CheckpointLoaderSimple",
      _meta: {
        title: "Load Checkpoint",
      },
    },
    "31": {
      inputs: {
        seed: input.seed,
        steps: input.steps,
        cfg: 1.0,
        sampler_name: input.sampler,
        scheduler: input.scheduler,
        denoise: 1,
        model: ["30", 0],
        positive: ["6", 0],
        negative: ["33", 0],
        latent_image: ["27", 0],
      },
      class_type: "KSampler",
      _meta: {
        title: "KSampler",
      },
    },
    "33": {
      inputs: {
        text: "",
        clip: ["30", 1],
      },
      class_type: "CLIPTextEncode",
      _meta: {
        title: "CLIP Text Encode (Negative Prompt)",
      },
    },
  };
}

const workflow: Workflow = {
  RequestSchema,
  generateWorkflow,
};

export default workflow;
