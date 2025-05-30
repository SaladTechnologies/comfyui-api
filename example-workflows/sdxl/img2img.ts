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
    .describe("The negative prompt for image generation"),
  width: z
    .number()
    .int()
    .min(256)
    .max(4096)
    .optional()
    .default(4096)
    .describe("Width of the generated image"),
  height: z
    .number()
    .int()
    .min(256)
    .max(4096)
    .optional()
    .default(4096)
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
    .default(20)
    .describe("Number of sampling steps"),
  cfg_scale: z
    .number()
    .min(0)
    .max(20)
    .optional()
    .default(5.5)
    .describe("Classifier-free guidance scale"),
  sampler_name: config.samplers
    .optional()
    .default("dpmpp_2m_sde_gpu")
    .describe("Name of the sampler to use"),
  scheduler: config.schedulers
    .optional()
    .default("exponential")
    .describe("Type of scheduler to use"),
  denoise: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.75)
    .describe("Denoising strength"),
  checkpoint,
  image: z.string().describe("Input image for img2img"),
  upscale_method: z
    .enum(["nearest-exact"])
    .optional()
    .default("nearest-exact")
    .describe(
      "Method used for upscaling if input image is smaller than target size"
    ),
  target_width: z
    .number()
    .int()
    .min(256)
    .max(4096)
    .optional()
    .default(1024)
    .describe("Target width for upscaling"),
  target_height: z
    .number()
    .int()
    .min(256)
    .max(4096)
    .optional()
    .default(1024)
    .describe("Target height for upscaling"),
});

type InputType = z.infer<typeof RequestSchema>;

function generateWorkflow(input: InputType): ComfyPrompt {
  return {
    "8": {
      inputs: {
        samples: ["36", 0],
        vae: ["14", 2],
      },
      class_type: "VAEDecode",
      _meta: {
        title: "VAE Decode",
      },
    },
    "9": {
      inputs: {
        filename_prefix: "img2img",
        images: ["8", 0],
      },
      class_type: "SaveImage",
      _meta: {
        title: "Save Image",
      },
    },
    "14": {
      inputs: {
        ckpt_name: input.checkpoint,
      },
      class_type: "CheckpointLoaderSimple",
      _meta: {
        title: "Load Checkpoint Base",
      },
    },
    "16": {
      inputs: {
        width: input.width,
        height: input.height,
        crop_w: 0,
        crop_h: 0,
        target_width: input.width,
        target_height: input.height,
        text_g: input.prompt,
        text_l: input.prompt,
        clip: ["14", 1],
      },
      class_type: "CLIPTextEncodeSDXL",
      _meta: {
        title: "CLIPTextEncodeSDXL",
      },
    },
    "19": {
      inputs: {
        width: input.width,
        height: input.height,
        crop_w: 0,
        crop_h: 0,
        target_width: input.width,
        target_height: input.height,
        text_g: input.negative_prompt,
        text_l: input.negative_prompt,
        clip: ["14", 1],
      },
      class_type: "CLIPTextEncodeSDXL",
      _meta: {
        title: "CLIPTextEncodeSDXL",
      },
    },
    "36": {
      inputs: {
        seed: input.seed,
        steps: input.steps,
        cfg: input.cfg_scale,
        sampler_name: input.sampler_name,
        scheduler: input.scheduler,
        denoise: input.denoise,
        model: ["14", 0],
        positive: ["16", 0],
        negative: ["19", 0],
        latent_image: ["39", 0],
      },
      class_type: "KSampler",
      _meta: {
        title: "KSampler",
      },
    },
    "38": {
      inputs: {
        image: input.image,
        upload: "image",
      },
      class_type: "LoadImage",
      _meta: {
        title: "Load Image",
      },
    },
    "39": {
      inputs: {
        pixels: ["40", 0],
        vae: ["14", 2],
      },
      class_type: "VAEEncode",
      _meta: {
        title: "VAE Encode",
      },
    },
    "40": {
      inputs: {
        upscale_method: input.upscale_method,
        width: input.target_width,
        height: input.target_height,
        crop: "center",
        image: ["38", 0],
      },
      class_type: "ImageScale",
      _meta: {
        title: "Upscale Image",
      },
    },
  };
}

const workflow: Workflow = {
  RequestSchema,
  generateWorkflow,
  summary: "Image-to-Image",
  description: "Text-guided Image-to-Image generation",
};

export default workflow;
