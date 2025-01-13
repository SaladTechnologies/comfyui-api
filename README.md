# ComfyUI API - A Stateless and Extendable API for ComfyUI

A simple wrapper that facilitates using ComfyUI as a stateless API, either by receiving images in the response, or by sending completed images to a webhook

- [ComfyUI API - A Stateless and Extendable API for ComfyUI](#comfyui-api---a-stateless-and-extendable-api-for-comfyui)
  - [Download and Usage](#download-and-usage)
  - [Features](#features)
  - [Probes](#probes)
  - [API Configuration Guide](#api-configuration-guide)
    - [Environment Variables](#environment-variables)
    - [Configuration Details](#configuration-details)
    - [Additional Notes](#additional-notes)
  - [Generating New Workflow Endpoints](#generating-new-workflow-endpoints)
    - [Automating with Claude 3.5 Sonnet](#automating-with-claude-35-sonnet)
  - [Prebuilt Docker Images](#prebuilt-docker-images)
  - [Contributing](#contributing)
  - [Testing](#testing)
    - [Required Models](#required-models)
    - [Running Tests](#running-tests)

## Download and Usage

Download the latest version from the release page, and copy it into your existing ComfyUI dockerfile. Then, you can use it like this:

```dockerfile
# Change this to the version you want to use
ARG api_version=1.7.0

# Download the comfyui-api binary, and make it executable
ADD https://github.com/SaladTechnologies/comfyui-api/releases/download/${api_version}/comfyui-api .
RUN chmod +x comfyui-api

# Set CMD to launch the comfyui-api binary. The comfyui-api binary will launch ComfyUI as a child process.
CMD ["./comfyui-api"]
```

The server will be available on port `3000` by default, but this can be customized with the `PORT` environment variable.

The server hosts swagger docs at `/docs`, which can be used to interact with the API.

## Features

- **Full Power Of ComfyUI**: The server supports the full ComfyUI /prompt API, and can be used to execute any ComfyUI workflow.
- **Verified Model/Workflow Support**: Stable Diffusion 1.5, Stable Diffusion XL, Stable Diffusion 3.5, Flux, AnimateDiff, LTX Video, Hunyuan Video, CogVideoX, Mochi Video. My assumption is more model types are supported, but these are the ones I have verified.
- **Stateless API**: The server is stateless, and can be scaled horizontally to handle more requests.
- **Swagger Docs**: The server hosts swagger docs at `/docs`, which can be used to interact with the API.
- **"Synchronous" Support**: The server will return base64-encoded images directly in the response, if no webhook is provided.
- **Webhook Support**: The server can send completed images to a webhook, which can be used to store images, or to send them to a user.
- **Easily Submit Images**: The server can accept images as base64-encoded strings, or as URLs to images. This makes image-to-image workflows much easier to use.
- **Warmup Workflow**: The server can be configured to run a warmup workflow on startup, which can be used to load and warm up models, and to ensure the server is ready to accept requests.
- **Return Images In PNG (default), JPEG, or WebP**: The server can return images in PNG, JPEG, or WebP format, via a parameter in the API request. Most options supported by [sharp](https://sharp.pixelplumbing.com/) are supported.
- **Probes**: The server has two probes, `/health` and `/ready`, which can be used to check the server's health and readiness to receive traffic.
- **Dynamic Workflow Endpoints**: Automatically mount new workflow endpoints by adding conforming `.js` or `.ts` files to the `/workflows` directory in your docker image. See [below](#generating-new-workflow-endpoints) for more information. A [Claude 3.5 Sonnet](https://claude.ai) [prompt](./claude-endpoint-creation-prompt.md) is included to assist in automating this process.
- **Bring Your Own Models And Extensions**: Use any model or extension you want by adding them to the normal ComfyUI directories `/opt/ComfyUI/`.
- **Works Great with SaladCloud**: The server is designed to work well with SaladCloud, and can be used to host ComfyUI on the SaladCloud platform. It is likely to work well with other platforms as well.
- **Single Binary**: The server is distributed as a single binary, and can be run with no dependencies.
- **Friendly License**: The server is distributed under the MIT license, and can be used for any purpose. All of its dependencies are also MIT or Apache 2.0 licensed, except ComfyUI itself, which is GPL-3.0 licensed.

## Probes

The server has two probes, `/health` and `/ready`.

- The `/health` probe will return a 200 status code once the warmup workflow has completed. It will stay healthy as long as the server is running, even if ComfyUI crashes.
- The `/ready` probe will also return a 200 status code once the warmup workflow has completed. It will return a 503 status code if ComfyUI is not running, such as in the case it has crashed, but is being automatically restarted.

Here's a markdown guide to configuring the application based on the provided config.ts file:

## API Configuration Guide

This guide provides an overview of how to configure the application using environment variables.

### Environment Variables

The following table lists the available environment variables and their default values.
The default values mostly assume this will run on top of an [ai-dock](https://github.com/ai-dock/comfyui) image, but can be customized as needed.

| Variable                 | Default Value         | Description                                                                                                                                                                                            |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CMD                      | "init.sh"             | Command to launch ComfyUI                                                                                                                                                                              |
| HOST                     | "::"                  | Wrapper host address                                                                                                                                                                                   |
| PORT                     | "3000"                | Wrapper port number                                                                                                                                                                                    |
| MAX_BODY_SIZE_MB         | "100"                 | Maximum body size in MB                                                                                                                                                                                |
| DIRECT_ADDRESS           | "127.0.0.1"           | Direct address for ComfyUI                                                                                                                                                                             |
| COMFYUI_PORT_HOST        | "8188"                | ComfyUI port number                                                                                                                                                                                    |
| STARTUP_CHECK_INTERVAL_S | "1"                   | Interval in seconds between startup checks                                                                                                                                                             |
| STARTUP_CHECK_MAX_TRIES  | "10"                  | Maximum number of startup check attempts                                                                                                                                                               |
| COMFY_HOME               | "/opt/ComfyUI"        | ComfyUI home directory                                                                                                                                                                                 |
| OUTPUT_DIR               | "/opt/ComfyUI/output" | Directory for output files                                                                                                                                                                             |
| INPUT_DIR                | "/opt/ComfyUI/input"  | Directory for input files                                                                                                                                                                              |
| MODEL_DIR                | "/opt/ComfyUI/models" | Directory for model files                                                                                                                                                                              |
| WARMUP_PROMPT_FILE       | (not set)             | Path to warmup prompt file (optional)                                                                                                                                                                  |
| WORKFLOW_DIR             | "/workflows"          | Directory for workflow files                                                                                                                                                                           |
| BASE                     | "ai-dock"             | There are different ways to load the comfyui environment for determining config values that vary with the base image. Currently only "ai-dock" has preset values. Set to empty string to not use this. |
| ALWAYS_RESTART_COMFYUI   | "false"               | If set to "true", the ComfyUI process will be automatically restarted if it exits. Otherwise, the API server will exit when ComfyUI exits.                                                             |

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
   - The application uses the `COMFY_HOME` environment variable to locate the ComfyUI installation.
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
  generateWorkflow: (input: any) => ComfyPrompt;
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
  summary: "Text to Image",
  description: "Generate an image from a text prompt",
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

### Automating with Claude 3.5 Sonnet

> **Note**: This requires having an account with Anthropic, and your anthropic API key in the environment variable `ANTHROPIC_API_KEY`.

Creating these endpoints can be done mostly automatically by [Claude 3.5 Sonnet](https://console.anthropic.com/), given the JSON prompt graph.
A system prompt to do this is included [here](./claude-endpoint-creation-prompt.md).

A script that uses this prompt to create endpoints is included [here](./generate-workflow). It requires `jq` and `curl` to be installed.

```shell
./generate-workflow <inputFile> <outputFile>
```

Where `<inputFile>` is the JSON prompt graph, and `<outputFile>` is the output file to write the generated workflow to.

As with all AI-generated code, it is strongly recommended to review the generated code before using it in production.

## Prebuilt Docker Images

There are several prebuilt Docker images using this server.
They are built from the [SaladCloud Recipes Repo](https://github.com/SaladTechnologies/salad-recipes/), and can be found on [Docker Hub](https://hub.docker.com/r/saladtechnologies/comfyui/tags).

The tag pattern is `saladtechnologies/comfyui:comfy<comfy-version>-api<api-version>-<model|base>` where:

- `<comfy-version>` is the version of ComfyUI used
- `<api-version>` is the version of the comfyui-api server
- `<model|base>` is the model used. There is a `base` tag for an image that contains ComfyUI and the comfyui-api server, but no models. There are also tags for specific models, like `sdxl-with-refiner` or `flux-schnell-fp8`.

## Contributing

Contributions are welcome! Please open an issue or a pull request if you have any suggestions or improvements.
ComfyUI is a powerful tool with MANY options, and it's likely that not all of them are currently supported by the comfyui-api server. If you find a feature that is missing, please open an issue or a pull request to add it. Let's make productionizing ComfyUI as easy as possible!

## Testing

### Required Models

Automated tests for this project require model files to be present in the `./test/docker-image/models` directory. The following models are required:

- `AnimateLCM_sd15_t2v.ckpt` - https://huggingface.co/wangfuyun/AnimateLCM/resolve/b78bbce/AnimateLCM_sd15_t2v.ckpt
- `dreamshaper_8.safetensors` - https://civitai.com/models/4384/dreamshaper
- `flux1-schnell-fp8.safetensors` - https://huggingface.co/Comfy-Org/flux1-schnell
- `ltx-video-2b-v0.9.1.safetensors` - https://huggingface.co/Lightricks/LTX-Video/blob/main/ltx-video-2b-v0.9.1.safetensors
- `sd3.5_medium.safetensors` - https://huggingface.co/stabilityai/stable-diffusion-3.5-medium
- `sd_xl_base_1.0.safetensors` - https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0
- `sd_xl_refiner_1.0.safetensors` - https://huggingface.co/stabilityai/stable-diffusion-xl-refiner-1.0
- `clip_g.safetensors` - https://huggingface.co/Comfy-Org/stable-diffusion-3.5-fp8/blob/main/text_encoders/clip_g.safetensors
- `clip_l.safetensors` - https://huggingface.co/Comfy-Org/stable-diffusion-3.5-fp8/blob/main/text_encoders/clip_l.safetensors
- `t5xxl_fp16.safetensors` - https://huggingface.co/comfyanonymous/flux_text_encoders/blob/main/t5xxl_fp16.safetensors
- `t5xxl_fp8_e4m3fn.safetensors` - https://huggingface.co/Comfy-Org/stable-diffusion-3.5-fp8/blob/main/text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors
- `openpose-sd1.5-1.1.safetensors` - https://huggingface.co/lllyasviel/control_v11p_sd15_openpose/resolve/main/diffusion_pytorch_model.fp16.safetensors
- `hunyuan_video_t2v_720p_bf16.safetensors` - https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/tree/main/split_files/diffusion_models
- `jump_V2.safetensors` - https://civitai.com/models/193225?modelVersionId=235847
- `llava_llama3_fp8_scaled.safetensors` - https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/tree/main/split_files/text_encoders
- `hunyuan_video_vae_bf16.safetensors` - https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/tree/main/split_files/vae
- `vae-ft-mse-840000-ema-pruned.ckpt` - https://huggingface.co/stabilityai/sd-vae-ft-mse-original/blob/main/vae-ft-mse-840000-ema-pruned.ckpt

They should be in the correct comfyui directory structure, like so:

```text
./test/docker-image/models
├── animatediff_models
│   └── AnimateLCM_sd15_t2v.ckpt
├── checkpoints
│   ├── dreamshaper_8.safetensors
│   ├── flux1-schnell-fp8.safetensors
│   ├── ltx-video-2b-v0.9.1.safetensors
│   ├── sd3.5_medium.safetensors
│   ├── sd_xl_base_1.0.safetensors
│   └── sd_xl_refiner_1.0.safetensors
├── clip
│   ├── clip_g.safetensors
│   ├── clip_l.safetensors
│   ├── t5xxl_fp16.safetensors
│   └── t5xxl_fp8_e4m3fn.safetensors
├── controlnet
│   ├── openpose-sd1.5-1.1.safetensors
├── diffusion_models
│   └── hunyuan_video_t2v_720p_bf16.safetensors
├── loras
│   ├── jump_V2.safetensors
├── text_encoders
│   ├── clip_l.safetensors
│   └── llava_llama3_fp8_scaled.safetensors
├── vae
│   ├── hunyuan_video_vae_bf16.safetensors
│   └── vae-ft-mse-840000-ema-pruned.ckpt
```

### Running Tests

In one terminal, start the test server:

```shell
docker compose up --build
```

> --build is only needed the first time, or if you make changes to the server code

In another terminal, run the tests:

```shell
npm test
```

This will take quite a long time, and requires a minimum of 24gb of RAM.
I did these tests on my RTX 3080ti Laptop Edition w/ 16gb VRAM, and 24gb WSL RAM.
It takes about 30 minutes to run all the tests.
