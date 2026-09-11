// Evaluated by the API's workflow loader. These fixtures back core.spec.ts.
const { z } = require("zod");
const template = JSON.parse(require("fs").readFileSync("/test-workflows/sd1.5-txt2img.json", "utf8"));

exports.default = {
  RequestSchema: z.object({
    prompt: z.string(),
    negative_prompt: z.string().default("text, watermark"),
    checkpoint: z.string().default("dreamshaper_8.safetensors"),
    width: z.number().int().default(512),
    height: z.number().int().default(512),
    seed: z.number().int().default(42),
    steps: z.number().int().default(20),
    cfg_scale: z.number().default(8),
    sampler_name: z.string().default("euler"),
    scheduler: z.string().default("normal"),
  }),
  generateWorkflow(input) {
    const prompt = JSON.parse(JSON.stringify(template));
    Object.assign(prompt["3"].inputs, {
      seed: input.seed, steps: input.steps, cfg: input.cfg_scale,
      sampler_name: input.sampler_name, scheduler: input.scheduler,
    });
    prompt["4"].inputs.ckpt_name = input.checkpoint;
    Object.assign(prompt["5"].inputs, { width: input.width, height: input.height });
    prompt["6"].inputs.text = input.prompt;
    prompt["7"].inputs.text = input.negative_prompt;
    return prompt;
  },
};
