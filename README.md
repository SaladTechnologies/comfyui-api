# comfyui-api
A simple wrapper that facilitates using ComfyUI as a stateless API, either by receiving images in the response, or by sending completed images to a webhook

Download the latest version from the release page, and copy it into your dockerfile. Then, you can use it like this:

```dockerfile
COPY comfyui-api .
RUN chmod +x comfyui-api

CMD ["./comfyui-api"]
```

The server will be available on port `3000` by default, but this can be customized with the `PORT` environment variable.

The server hosts swagger docs at `/docs`, which can be used to interact with the API.

## Probes

The server has two probes, `/health` and `/ready`. 
- The `/health` probe will return a 200 status code once the warmup workflow has complete.
- The `/ready` probe will also return a 200 status code once the warmup workflow has completed, and the server is ready to accept requests.

## Application Configuration Guide

This application uses environment variables for configuration. Below are the available options and their default values:

### Environment Variables

- `CMD`: Command to launch ComfyUI (default: "init.sh")
- `HOST`: Host to bind the wrapper server (default: "::")
- `PORT`: Port for the wrapper server (default: "3000")
- `DIRECT_ADDRESS`: Direct address for internal communication (default: "127.0.0.1")
- `COMFYUI_PORT_HOST`: Port for ComfyUI (default: "8188")
- `STARTUP_CHECK_INTERVAL_S`: Interval in seconds between startup checks (default: "1")
- `STARTUP_CHECK_MAX_TRIES`: Maximum number of startup check attempts (default: "10")
- `OUTPUT_DIR`: Directory for output files (default: "/opt/ComfyUI/output")
- `INPUT_DIR`: Directory for input files (default: "/opt/ComfyUI/input")
- `MODEL_DIR`: Directory for model files (default: "/opt/ComfyUI/models")
- `WARMUP_PROMPT_FILE`: Path to a JSON file containing a warmup prompt (optional)
- `WORKFLOW_MODELS`: Specify which models to include in workflows (default: "all")

### Configuration Details

1. The application will use `http://${DIRECT_ADDRESS}:${COMFYUI_PORT_HOST}` to communicate with ComfyUI.
2. The wrapper server will be accessible at `http://localhost:${PORT}`.
3. If `WARMUP_PROMPT_FILE` is specified, it must exist and contain valid JSON. The application will attempt to extract the checkpoint name from this file.
4. The `MODEL_DIR` is scanned for subdirectories. Each subdirectory is treated as a model category, and its contents are listed as available models.

### Model Configuration

Models are automatically detected from the `MODEL_DIR`. Each subdirectory in `MODEL_DIR` is considered a model category. The application creates an enumeration of all files in each category, which can be used for validation in the application.

## Generating New Workflow Template Endpoints

Since the ComfyUI prompt format is a little obtuse, it's common to wrap the workflow endpoints with a more user-friendly interface.

This can be done by adding conforming `.js` or `.ts` files to the `/workflows` directory in your dockerfile.
You can see some examples in [`src/workflows`](./src/workflows/).
Typescript files will be automatically transpiled to javascript files, so you can use either.

Here is an example text-to-image workflow file.

```typescript
import { z } from "zod";
import config from "../config";

const ComfyNodeSchema = z.object({
  inputs: z.any(),
  class_type: z.string(),
  _meta: z.any().optional(),
});

type ComfyNode = z.infer<typeof ComfyNodeSchema>;

interface Workflow {
  RequestSchema: z.ZodObject<any, any>;
  generateWorkflow: (input: any) => Record<string, ComfyNode>;
}

// This defaults the checkpoint to whatever was used in the warmup workflow
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
  checkpoint,
});

type InputType = z.infer<typeof RequestSchema>;

function generateWorkflow(input: InputType): Record<string, ComfyNode> {
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
        filename_prefix: "ComfyUI",
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
```

Note your file MUST export a `Workflow` object, which contains a `RequestSchema` and a `generateWorkflow` function. The `RequestSchema` is a zod schema that describes the input to the workflow, and the `generateWorkflow` function takes the input and returns a ComfyUI API-format prompt.

The workflow endpoints will follow whatever directory structure you provide.
For example, a directory structure like this:

```shell
/workflows
└── sdxl
    ├── img2img.ts
    ├── txt2img-with-refiner.ts
    └── txt2img.ts
```

Would yield the following endpoints:
- `POST /workflows/sdxl/img2img`
- `POST /workflows/sdxl/txt2img-with-refiner`
- `POST /workflows/sdxl/txt2img`

These endpoints will be present in the swagger docs, and can be used to interact with the API.
If you provide descriptions in your zod schemas, these will be used to create a table of inputs in the swagger docs.