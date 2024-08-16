import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert";

// Looks for api key in envvar ANTHROPIC_API_KEY
assert(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY envvar not set");
const anthropic = new Anthropic();

async function generateWorkflow(input: string): Promise<any> {
  const msg = await anthropic.messages.create(
    {
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 8192,
      temperature: 0,
      system:
        'Your job is to convert a json workflow graph for ai image generation into a typescript function. You should define a type for the input, using Zod for validation. You should use `.describe` to describe each parameter to the best of your ability. filename prefix is always set by the system in a different location. Do not extrapolate enum values. Always take the checkpoint value from config and types as demonstrated. Use snake_case for multi-word parameters. Only output the typescript, with no additional commentary. Here is an example output:\n\n```typescript\nimport { z } from "zod";\nimport { ComfyNode, Workflow } from "../../types";\nimport config from "../../config";\n\nlet checkpoint: any = config.models.checkpoints.enum.optional();\nif (config.warmupCkpt) {\n  checkpoint = checkpoint.default(config.warmupCkpt);\n}\n\nconst RequestSchema = z.object({\n  prompt: z.string().describe("The positive prompt for image generation"),\n  negative_prompt: z\n    .string()\n    .optional()\n    .describe("The negative prompt for image generation"),\n  width: z\n    .number()\n    .int()\n    .min(256)\n    .max(2048)\n    .optional()\n    .default(1024)\n    .describe("Width of the generated image"),\n  height: z\n    .number()\n    .int()\n    .min(256)\n    .max(2048)\n    .optional()\n    .default(1024)\n    .describe("Height of the generated image"),\n  seed: z\n    .number()\n    .int()\n    .optional()\n    .default(() => Math.floor(Math.random() * 1000000000000000))\n    .describe("Seed for random number generation"),\n  steps: z\n    .number()\n    .int()\n    .min(1)\n    .max(100)\n    .optional()\n    .default(20)\n    .describe("Number of sampling steps"),\n  cfg_scale: z\n    .number()\n    .min(0)\n    .max(20)\n    .optional()\n    .default(5.5)\n    .describe("Classifier-free guidance scale"),\n  sampler_name: z\n    .enum(["dpmpp_2m_sde_gpu"])\n    .optional()\n    .default("dpmpp_2m_sde_gpu")\n    .describe("Name of the sampler to use"),\n  scheduler: z\n    .enum(["exponential"])\n    .optional()\n    .default("exponential")\n    .describe("Type of scheduler to use"),\n  denoise: z\n    .number()\n    .min(0)\n    .max(1)\n    .optional()\n    .default(0.75)\n    .describe("Denoising strength"),\n  checkpoint,\n  image: z.string().describe("Input image for img2img"),\n  upscale_method: z\n    .enum(["nearest-exact"])\n    .optional()\n    .default("nearest-exact")\n    .describe(\n      "Method used for upscaling if input image is smaller than target size"\n    ),\n  target_width: z\n    .number()\n    .int()\n    .min(256)\n    .max(4096)\n    .optional()\n    .default(1024)\n    .describe("Target width for upscaling"),\n  target_height: z\n    .number()\n    .int()\n    .min(256)\n    .max(4096)\n    .optional()\n    .default(1024)\n    .describe("Target height for upscaling"),\n});\n\ntype InputType = z.infer<typeof RequestSchema>;\n\nfunction generateWorkflow(input: InputType): Record<string, ComfyNode> {\n  return {\n    "8": {\n      inputs: {\n        samples: ["36", 0],\n        vae: ["14", 2],\n      },\n      class_type: "VAEDecode",\n      _meta: {\n        title: "VAE Decode",\n      },\n    },\n    "9": {\n      inputs: {\n        filename_prefix: "img2img",\n        images: ["8", 0],\n      },\n      class_type: "SaveImage",\n      _meta: {\n        title: "Save Image",\n      },\n    },\n    "14": {\n      inputs: {\n        ckpt_name: input.checkpoint,\n      },\n      class_type: "CheckpointLoaderSimple",\n      _meta: {\n        title: "Load Checkpoint Base",\n      },\n    },\n    "16": {\n      inputs: {\n        width: input.width,\n        height: input.height,\n        crop_w: 0,\n        crop_h: 0,\n        target_width: input.width,\n        target_height: input.height,\n        text_g: input.prompt,\n        text_l: input.prompt,\n        clip: ["14", 1],\n      },\n      class_type: "CLIPTextEncodeSDXL",\n      _meta: {\n        title: "CLIPTextEncodeSDXL",\n      },\n    },\n    "19": {\n      inputs: {\n        width: input.width,\n        height: input.height,\n        crop_w: 0,\n        crop_h: 0,\n        target_width: input.width,\n        target_height: input.height,\n        text_g: input.negative_prompt,\n        text_l: input.negative_prompt,\n        clip: ["14", 1],\n      },\n      class_type: "CLIPTextEncodeSDXL",\n      _meta: {\n        title: "CLIPTextEncodeSDXL",\n      },\n    },\n    "36": {\n      inputs: {\n        seed: input.seed,\n        steps: input.steps,\n        cfg: input.cfg_scale,\n        sampler_name: input.sampler_name,\n        scheduler: input.scheduler,\n        denoise: input.denoise,\n        model: ["14", 0],\n        positive: ["16", 0],\n        negative: ["19", 0],\n        latent_image: ["39", 0],\n      },\n      class_type: "KSampler",\n      _meta: {\n        title: "KSampler",\n      },\n    },\n    "38": {\n      inputs: {\n        image: input.image,\n        upload: "image",\n      },\n      class_type: "LoadImage",\n      _meta: {\n        title: "Load Image",\n      },\n    },\n    "39": {\n      inputs: {\n        pixels: ["40", 0],\n        vae: ["14", 2],\n      },\n      class_type: "VAEEncode",\n      _meta: {\n        title: "VAE Encode",\n      },\n    },\n    "40": {\n      inputs: {\n        upscale_method: input.upscale_method,\n        width: input.target_width,\n        height: input.target_height,\n        crop: "center",\n        image: ["38", 0],\n      },\n      class_type: "ImageScale",\n      _meta: {\n        title: "Upscale Image",\n      },\n    },\n  };\n}\n\nconst workflow: Workflow = {\n  RequestSchema,\n  generateWorkflow,\n};\n\nexport default workflow;\n\n```\n',
      messages: [
        {
          role: "user",
          content: input,
        },
      ],
    },
    {
      headers: {
        "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15",
      },
    }
  );
  let response =
    msg.content[0].type === "text" ? msg.content[0].text : JSON.stringify(msg);
  if (response.startsWith("```")) {
    const first = response.indexOf("\n");
    response = response.slice(first + 1, response.lastIndexOf("```"));
  }
  return response;
}

const usage = `Usage: node generateWorkflow.js <inputFile> <outputFile>`;
async function main() {
  // input is the contents of a file provided in the first arg
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];

  assert(inputFile, usage);
  assert(outputFile, usage);

  const inputContent = await fs.readFile(inputFile, "utf-8");
  const output = await generateWorkflow(inputContent);

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(outputFile);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputFile, output);
}

main();
