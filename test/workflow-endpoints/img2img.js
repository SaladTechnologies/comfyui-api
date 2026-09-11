const { z } = require("zod");
const template = JSON.parse(require("fs").readFileSync("/test-workflows/sd1.5-img2img.json", "utf8"));

exports.default = {
  RequestSchema: z.object({
    image: z.string(),
    prompt: z.string(),
    negative_prompt: z.string().default("text, watermark"),
    checkpoint: z.string().default("dreamshaper_8.safetensors"),
    width: z.number().int().default(512),
    height: z.number().int().default(512),
    seed: z.number().int().default(42),
    steps: z.number().int().default(20),
    cfg_scale: z.number().default(8),
    denoise: z.number().default(0.75),
  }),
  generateWorkflow(input) {
    const prompt = JSON.parse(JSON.stringify(template));
    Object.assign(prompt["3"].inputs, {
      seed: input.seed, steps: input.steps, cfg: input.cfg_scale, denoise: input.denoise,
    });
    prompt["14"].inputs.ckpt_name = input.checkpoint;
    prompt["6"].inputs.text = input.prompt;
    prompt["7"].inputs.text = input.negative_prompt;
    prompt["10"].inputs.image = input.image;
    prompt["20"] = {
      class_type: "ImageScale",
      inputs: { image: ["10", 0], upscale_method: "bilinear", width: input.width, height: input.height, crop: "disabled" },
    };
    // Use the resized input in the VAE encoder.
    for (const node of Object.values(prompt)) {
      if (node.class_type === "VAEEncode") node.inputs.pixels = ["20", 0];
    }
    return prompt;
  },
};
