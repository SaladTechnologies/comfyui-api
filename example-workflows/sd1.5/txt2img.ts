import { z } from "zod";
// This gets evaluated in the context of src/workflows, so imports must be relative to that directory
import { ComfyPrompt, Workflow } from "../types";
import config from "../config";

const RequestSchema = z.object({
  prompt: z.string().describe("The positive prompt for image generation"),
  negative_prompt: z
    .string()
    .optional()
    .default("")
    .describe("The negative prompt for image generation"),
  width: z
    .number()
    .int()
    .min(256)
    .max(2048)
    .optional()
    .default(512)
    .describe("Width of the generated image"),
  height: z
    .number()
    .int()
    .min(256)
    .max(2048)
    .optional()
    .default(512)
    .describe("Height of the generated image"),
  seed: z
    .number()
    .int()
    .optional()
    .default(() => Math.floor(Math.random() * 100000000000))
    .describe("Seed for random number generation"),
  steps: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe("Number of sampling steps"),
  cfg_scale: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .default(8)
    .describe("Classifier-free guidance scale"),
  sampler_name: config.samplers
    .optional()
    .default("euler")
    .describe("Name of the sampler to use"),
  scheduler: config.schedulers
    .optional()
    .default("normal")
    .describe("Type of scheduler to use"),
  denoise: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(1)
    .describe("Denoising strength"),
  checkpoint: z
    .string()
    .refine((val) => config.models.checkpoints.all.includes(val))
    .optional()
    .default(config.warmupCkpt || config.models.checkpoints.all[0])
    .describe("Checkpoint to use"),
});

type InputType = z.infer<typeof RequestSchema>;

function generateWorkflow(input: InputType): ComfyPrompt {
  return {
    "3": {
      inputs: {
        seed: input.seed,
        steps: input.steps,
        cfg: input.cfg_scale,
        sampler_name: input.sampler_name,
        scheduler: input.scheduler,
        denoise: input.denoise,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
      class_type: "KSampler",
      _meta: {
        title: "KSampler",
      },
    },
    "4": {
      inputs: {
        ckpt_name: input.checkpoint,
      },
      class_type: "CheckpointLoaderSimple",
      _meta: {
        title: "Load Checkpoint",
      },
    },
    "5": {
      inputs: {
        width: input.width,
        height: input.height,
        batch_size: 1,
      },
      class_type: "EmptyLatentImage",
      _meta: {
        title: "Empty Latent Image",
      },
    },
    "6": {
      inputs: {
        text: input.prompt,
        clip: ["4", 1],
      },
      class_type: "CLIPTextEncode",
      _meta: {
        title: "CLIP Text Encode (Prompt)",
      },
    },
    "7": {
      inputs: {
        text: input.negative_prompt,
        clip: ["4", 1],
      },
      class_type: "CLIPTextEncode",
      _meta: {
        title: "CLIP Text Encode (Prompt)",
      },
    },
    "8": {
      inputs: {
        samples: ["3", 0],
        vae: ["4", 2],
      },
      class_type: "VAEDecode",
      _meta: {
        title: "VAE Decode",
      },
    },
    "9": {
      inputs: {
        filename_prefix: "output",
        images: ["8", 0],
      },
      class_type: "SaveImage",
      _meta: {
        title: "Save Image",
      },
    },
  };
}

const workflow: Workflow = {
  RequestSchema,
  generateWorkflow,
};

export default workflow;
