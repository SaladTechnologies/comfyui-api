import { z } from "zod";
// This gets evaluated in the context of src/workflows, so imports must be relative to that directory
import { ComfyPrompt, Workflow } from "../types";
import config from "../config";

let checkpoint: any = config.models.checkpoints.enum.optional();
if (config.warmupCkpt) {
  checkpoint = checkpoint.default(config.warmupCkpt);
}

const RequestSchema = z.object({
  prompt: z.string().describe("The positive prompt for image generation"),
  negative_prompt: z
    .string()
    .optional()
    .default("text, watermark")
    .describe("The negative prompt for image generation"),
  width: z
    .number()
    .int()
    .min(256)
    .max(2048)
    .optional()
    .default(1024)
    .describe("Width of the generated image"),
  height: z
    .number()
    .int()
    .min(256)
    .max(2048)
    .optional()
    .default(1024)
    .describe("Height of the generated image"),
  seed: z
    .number()
    .int()
    .optional()
    .default(() => Math.floor(Math.random() * 1000000000000000))
    .describe("Seed for random number generation"),
  steps: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(25)
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
  base_start_step: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(0)
    .describe("Start step for base model sampling"),
  base_end_step: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(20)
    .describe("End step for base model sampling"),
  refiner_start_step: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(20)
    .describe("Start step for refiner model sampling"),
  checkpoint,
  refiner_checkpoint: z
    .string()
    .optional()
    .default("sd_xl_refiner_1.0.safetensors")
    .describe("Checkpoint for the refiner model"),
});

type InputType = z.infer<typeof RequestSchema>;

function generateWorkflow(input: InputType): ComfyPrompt {
  return {
    "4": {
      inputs: {
        ckpt_name: input.checkpoint,
      },
      class_type: "CheckpointLoaderSimple",
      _meta: {
        title: "Load Checkpoint - BASE",
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
    "10": {
      inputs: {
        add_noise: "enable",
        noise_seed: input.seed,
        steps: input.steps,
        cfg: input.cfg_scale,
        sampler_name: input.sampler_name,
        scheduler: input.scheduler,
        start_at_step: input.base_start_step,
        end_at_step: input.base_end_step,
        return_with_leftover_noise: "enable",
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
      class_type: "KSamplerAdvanced",
      _meta: {
        title: "KSampler (Advanced) - BASE",
      },
    },
    "11": {
      inputs: {
        add_noise: "disable",
        noise_seed: 0,
        steps: input.steps,
        cfg: input.cfg_scale,
        sampler_name: input.sampler_name,
        scheduler: input.scheduler,
        start_at_step: input.refiner_start_step,
        end_at_step: 10000,
        return_with_leftover_noise: "disable",
        model: ["12", 0],
        positive: ["15", 0],
        negative: ["16", 0],
        latent_image: ["10", 0],
      },
      class_type: "KSamplerAdvanced",
      _meta: {
        title: "KSampler (Advanced) - REFINER",
      },
    },
    "12": {
      inputs: {
        ckpt_name: input.refiner_checkpoint,
      },
      class_type: "CheckpointLoaderSimple",
      _meta: {
        title: "Load Checkpoint - REFINER",
      },
    },
    "15": {
      inputs: {
        text: input.prompt,
        clip: ["12", 1],
      },
      class_type: "CLIPTextEncode",
      _meta: {
        title: "CLIP Text Encode (Prompt)",
      },
    },
    "16": {
      inputs: {
        text: input.negative_prompt,
        clip: ["12", 1],
      },
      class_type: "CLIPTextEncode",
      _meta: {
        title: "CLIP Text Encode (Prompt)",
      },
    },
    "17": {
      inputs: {
        samples: ["11", 0],
        vae: ["12", 2],
      },
      class_type: "VAEDecode",
      _meta: {
        title: "VAE Decode",
      },
    },
    "19": {
      inputs: {
        filename_prefix: "ComfyUI",
        images: ["17", 0],
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
