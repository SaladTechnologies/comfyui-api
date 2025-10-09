"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var zod_1 = require("zod");
var config_1 = require("../config");
var RequestSchema = zod_1.z.object({
    prompt: zod_1.z.string().describe("The positive prompt for image generation"),
    negative_prompt: zod_1.z
        .string()
        .optional()
        .default("text, watermark")
        .describe("The negative prompt for image generation"),
    seed: zod_1.z
        .number()
        .int()
        .optional()
        .default(function () { return Math.floor(Math.random() * 1000000000000000); })
        .describe("Seed for random number generation"),
    steps: zod_1.z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(15)
        .describe("Number of sampling steps"),
    cfg_scale: zod_1.z
        .number()
        .min(0)
        .max(20)
        .optional()
        .default(8)
        .describe("Classifier-free guidance scale"),
    sampler_name: config_1.default.samplers
        .optional()
        .default("euler")
        .describe("Name of the sampler to use"),
    scheduler: config_1.default.schedulers
        .optional()
        .default("normal")
        .describe("Type of scheduler to use"),
    denoise: zod_1.z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.8)
        .describe("Denoising strength"),
    checkpoint: zod_1.z
        .string()
        .refine(function (val) { return config_1.default.models.checkpoints.all.includes(val); })
        .optional()
        .default(config_1.default.warmupCkpt || config_1.default.models.checkpoints.all[0])
        .describe("Checkpoint to use"),
    image: zod_1.z.string().describe("Input image for img2img"),
    width: zod_1.z
        .number()
        .int()
        .min(64)
        .max(2048)
        .optional()
        .default(512)
        .describe("Width of the generated image"),
    height: zod_1.z
        .number()
        .int()
        .min(64)
        .max(2048)
        .optional()
        .default(512)
        .describe("Height of the generated image"),
    interpolation: zod_1.z
        .enum(["nearest"])
        .optional()
        .default("nearest")
        .describe("Interpolation method for image resizing"),
    resize_method: zod_1.z
        .enum(["keep proportion"])
        .optional()
        .default("keep proportion")
        .describe("Method for resizing the image"),
    resize_condition: zod_1.z
        .enum(["always"])
        .optional()
        .default("always")
        .describe("Condition for when to resize the image"),
    multiple_of: zod_1.z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Ensure dimensions are multiples of this value"),
});
function generateWorkflow(input) {
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
                latent_image: ["12", 0],
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
        "10": {
            inputs: {
                image: input.image,
                upload: "image",
            },
            class_type: "LoadImage",
            _meta: {
                title: "Load Image",
            },
        },
        "11": {
            inputs: {
                width: input.width,
                height: input.height,
                interpolation: input.interpolation,
                method: input.resize_method,
                condition: input.resize_condition,
                multiple_of: input.multiple_of,
                image: ["10", 0],
            },
            class_type: "ImageResize+",
            _meta: {
                title: "🔧 Image Resize",
            },
        },
        "12": {
            inputs: {
                pixels: ["11", 0],
                vae: ["4", 2],
            },
            class_type: "VAEEncode",
            _meta: {
                title: "VAE Encode",
            },
        },
    };
}
var workflow = {
    RequestSchema: RequestSchema,
    generateWorkflow: generateWorkflow,
    summary: "Image-to-Image",
    description: "Text-guided Image-to-Image generation",
};
exports.default = workflow;
