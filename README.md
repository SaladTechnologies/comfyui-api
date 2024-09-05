# ComfyUI API - A Stateless and Extendable API for ComfyUI
A simple wrapper that facilitates using ComfyUI as a stateless API, either by receiving images in the response, or by sending completed images to a webhook

Download the latest version from the release page, and copy it into your existing ComfyUI dockerfile. Then, you can use it like this:

```dockerfile
COPY comfyui-api .
RUN chmod +x comfyui-api

CMD ["./comfyui-api"]
```

The server will be available on port `3000` by default, but this can be customized with the `PORT` environment variable.

The server hosts swagger docs at `/docs`, which can be used to interact with the API.

## Features

- **Full Power Of ComfyUI**: The server supports the full ComfyUI /prompt API, and can be used to execute any ComfyUI workflow.
- **Stateless API**: The server is stateless, and can be scaled horizontally to handle more requests.
- **Swagger Docs**: The server hosts swagger docs at `/docs`, which can be used to interact with the API.
- **"Synchronous" Support**: The server will return base64-encoded images directly in the response, if no webhook is provided.
- **Webhook Support**: The server can send completed images to a webhook, which can be used to store images, or to send them to a user.
- **Warmup Workflow**: The server can be configured to run a warmup workflow on startup, which can be used to load models, and to ensure the server is ready to accept requests.
- **Probes**: The server has two probes, `/health` and `/ready`, which can be used to check the server's health and readiness to receive traffic.
- **Dynamic Workflow Endpoints**: Automatically mount new workflow endpoints by adding conforming `.js` or `.ts` files to the `/workflows` directory in your docker image. See [below](#generating-new-workflow-endpoints) for more information.
- **Works Great with Salad**: The server is designed to work well with Salad, and can be used to host ComfyUI on the Salad platform. It is likely to work well with other platforms as well.

## Probes

The server has two probes, `/health` and `/ready`. 
- The `/health` probe will return a 200 status code once the warmup workflow has complete.
- The `/ready` probe will also return a 200 status code once the warmup workflow has completed, and the server is ready to accept requests.

Here's a markdown guide to configuring the application based on the provided config.ts file:

## API Configuration Guide

This guide provides an overview of how to configure the application using environment variables.

### Environment Variables

The following table lists the available environment variables and their default values.
The default values mostly assume this will run on top of an [ai-dock](https://github.com/ai-dock/comfyui) image, but can be customized as needed.

| Variable | Default Value | Description |
|----------|---------------|-------------|
| CMD | "init.sh" | Command to launch ComfyUI |
| HOST | "::" | Wrapper host address |
| PORT | "3000" | Wrapper port number |
| DIRECT_ADDRESS | "127.0.0.1" | Direct address for ComfyUI |
| COMFYUI_PORT_HOST | "8188" | ComfyUI port number |
| STARTUP_CHECK_INTERVAL_S | "1" | Interval in seconds between startup checks |
| STARTUP_CHECK_MAX_TRIES | "10" | Maximum number of startup check attempts |
| OUTPUT_DIR | "/opt/ComfyUI/output" | Directory for output files |
| INPUT_DIR | "/opt/ComfyUI/input" | Directory for input files |
| MODEL_DIR | "/opt/ComfyUI/models" | Directory for model files |
| WARMUP_PROMPT_FILE | (not set) | Path to warmup prompt file (optional) |
| WORKFLOW_DIR | "/workflows" | Directory for workflow files |

### Configuration Details

1. **ComfyUI Settings**:
   - The application uses the `CMD` environment variable to specify the command for launching ComfyUI.
   - ComfyUI is accessed at `http://${DIRECT_ADDRESS}:${COMFYUI_PORT_HOST}`.

2. **Wrapper Settings**:
   - The wrapper API listens on `HOST:PORT`.
   - It can be accessed at `http://localhost:${PORT}`.
   - Use an IPv6 address for `HOST` when deploying on Salad. This is the default behavior.

3. **Startup Checks**:
   - The application performs startup checks at intervals specified by `STARTUP_CHECK_INTERVAL_S`.
   - It will attempt up to `STARTUP_CHECK_MAX_TRIES` before giving up.

4. **Directories**:
   - Output files are stored in `OUTPUT_DIR`.
   - Input files are read from `INPUT_DIR`.
   - Model files are located in `MODEL_DIR`.
   - Workflow files are stored in `WORKFLOW_DIR`. See [below](#generating-new-workflow-endpoints) for more information.

5. **Warmup Prompt**:
   - If `WARMUP_PROMPT_FILE` is set, the application will load and parse a warmup prompt from this file.
   - The checkpoint used in this prompt can be used as the default for workflow models.

6. **Models**:
   - The application scans the `MODEL_DIR` for subdirectories and creates configurations for each model type found.
   - Each model type will have its directory path, list of available models, and a Zod enum for validation.
   - The model names are exposed via the `GET /models` endpoint, and via the config object throughout the application.

7. **ComfyUI Description**:
   - The application retrieves available samplers and schedulers from ComfyUI.
   - This information is used to create Zod enums for validation.

### Additional Notes

- The application uses Zod for runtime type checking and validation of configuration values.
- The configuration includes setup for both the wrapper application and ComfyUI itself.

Remember to set these environment variables according to your specific deployment needs before running the application.

## Generating New Workflow Endpoints

Since the ComfyUI prompt format is a little obtuse, it's common to wrap the workflow endpoints with a more user-friendly interface.

This can be done by adding conforming `.js` or `.ts` files to the `/workflows` directory in your dockerfile.
You can see some examples in [`./workflows`](./workflows/).
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