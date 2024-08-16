import { z } from "zod";
import { ComfyNode, Workflow, AvailableCheckpoints } from "../../types";
import config from "../../config";

let checkpoint: any = AvailableCheckpoints.optional();
if (config.warmupCkpt) {
  checkpoint = AvailableCheckpoints.default(config.warmupCkpt);
}

const RequestSchema = z.object({
  prompt: z.string(),
  width: z.number().int().min(256).max(1024).optional().default(1024),
  height: z.number().int().min(256).max(1024).optional().default(1024),
  seed: z
    .number()
    .int()
    .optional()
    .default(() => Math.floor(Math.random() * 1000000000000000)),
  steps: z.number().int().min(1).max(10).optional().default(2),
  sampler: z.enum(["euler"]).optional().default("euler"),
  scheduler: z.enum(["simple"]).optional().default("simple"),
  denoise: z.number().min(0).max(1).optional().default(0.8),
  cfg: z.number().min(1).max(30).optional().default(1),
  image: z.string(),
  checkpoint,
});

type InputType = z.infer<typeof RequestSchema>;

function generateWorkflow(input: InputType): Record<string, ComfyNode> {
  return {
    "6": {
      inputs: {
        text: input.prompt,
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
        cfg: input.cfg,
        sampler_name: input.sampler,
        scheduler: input.scheduler,
        denoise: input.denoise,
        model: ["30", 0],
        positive: ["6", 0],
        negative: ["33", 0],
        latent_image: ["38", 0],
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
    "37": {
      inputs: {
        image: input.image,
        upload: "image",
      },
      class_type: "LoadImage",
      _meta: {
        title: "Load Image",
      },
    },
    "38": {
      inputs: {
        pixels: ["40", 0],
        vae: ["30", 2],
      },
      class_type: "VAEEncode",
      _meta: {
        title: "VAE Encode",
      },
    },
    "40": {
      inputs: {
        width: input.width,
        height: input.height,
        interpolation: "nearest",
        method: "fill / crop",
        condition: "always",
        multiple_of: 8,
        image: ["37", 0],
      },
      class_type: "ImageResize+",
      _meta: {
        title: "🔧 Image Resize",
      },
    },
  };
}

const workflow: Workflow = {
  RequestSchema,
  generateWorkflow,
};

export default workflow;
