import { z } from "zod";
import { ComfyNode, Workflow, AvailableCheckpoints } from "../../types";
import config from "../../config";

let checkpoint: any = AvailableCheckpoints.optional();
if (config.warmupCkpt) {
  checkpoint = AvailableCheckpoints.default(config.warmupCkpt);
}

const RequestSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional().default(""),
  width: z.number().int().min(256).max(2048).optional().default(1024),
  height: z.number().int().min(256).max(2048).optional().default(1024),
  seed: z
    .number()
    .int()
    .optional()
    .default(() => Math.floor(Math.random() * 1000000000000000)),
  steps: z.number().int().min(1).max(100).optional().default(20),
  cfg: z.number().min(0).max(20).optional().default(5.5),
  denoise: z.number().min(0).max(1).optional().default(0.75),
  sampler: z.enum(["dpmpp_2m_sde_gpu"]).optional().default("dpmpp_2m_sde_gpu"),
  scheduler: z.enum(["exponential"]).optional().default("exponential"),
  checkpoint,
  image: z.string(),
});

type InputType = z.infer<typeof RequestSchema>;

function generateWorkflow(input: InputType): Record<string, ComfyNode> {
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
        text_g: input.negativePrompt,
        text_l: input.negativePrompt,
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
        cfg: input.cfg,
        sampler_name: input.sampler,
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
        upscale_method: "nearest-exact",
        width: 1024,
        height: 1024,
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
};

export default workflow;
