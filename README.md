# ComfyUI API - A Stateless and Extendable API for ComfyUI

A simple wrapper that facilitates using [ComfyUI](https://github.com/comfyanonymous/ComfyUI/) as a stateless API, either by receiving images in the response, or by sending completed images to a webhook

- [ComfyUI API - A Stateless and Extendable API for ComfyUI](#comfyui-api---a-stateless-and-extendable-api-for-comfyui)
  - [Download and Use](#download-and-use)
  - [Features](#features)
  - [Probes](#probes)
  - [API Configuration Guide](#api-configuration-guide)
    - [Environment Variables](#environment-variables)
    - [Configuration Details](#configuration-details)
    - [Additional Notes](#additional-notes)
  - [Using Synchronously](#using-synchronously)
  - [Using with Webhooks](#using-with-webhooks)
    - [output.complete](#outputcomplete)
    - [prompt.failed](#promptfailed)
  - [Using with S3](#using-with-s3)
  - [System Events](#system-events)
    - [status](#status)
    - [progress](#progress)
    - [executing](#executing)
    - [execution\_start](#execution_start)
    - [execution\_cached](#execution_cached)
    - [executed](#executed)
    - [execution\_success](#execution_success)
    - [execution\_interrupted](#execution_interrupted)
    - [execution\_error](#execution_error)
  - [Generating New Workflow Endpoints](#generating-new-workflow-endpoints)
    - [Automating with Claude 4 Sonnet](#automating-with-claude-4-sonnet)
  - [Prebuilt Docker Images](#prebuilt-docker-images)
  - [Considerations for Running on SaladCloud](#considerations-for-running-on-saladcloud)
  - [Contributing](#contributing)
  - [Testing](#testing)
    - [Required Models](#required-models)
    - [Running Tests](#running-tests)
  - [Architecture](#architecture)

## Download and Use

Either use a [pre-built Docker image](#prebuilt-docker-images), or build your own.

Download the latest version from the release page, and copy it into your existing ComfyUI dockerfile.
You can find good base dockerfiles in the [docker](./docker) directory.
There are also example dockerfiles for popular models in the [SaladCloud Recipes Repo](https://github.com/SaladTechnologies/salad-recipes/tree/master/src).

If you have your own ComfyUI dockerfile, you can add the comfyui-api server to it like so:

```dockerfile
# Change this to the version you want to use
ARG api_version=1.9.0


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
- **Verified Model/Workflow Support**: Stable Diffusion 1.5, Stable Diffusion XL, Stable Diffusion 3.5, Flux, AnimateDiff, LTX Video, Hunyuan Video, CogVideoX, Mochi Video, Cosmos 1.0. My assumption is more model types are supported, but these are the ones I have verified.
- **Stateless API**: The server is stateless, and can be scaled horizontally to handle more requests.
- **Swagger Docs**: The server hosts swagger docs at `/docs`, which can be used to interact with the API.
- **"Synchronous" Support**: The server will return base64-encoded images directly in the response, if no webhook is provided.
- **Webhook Support**: The server can send completed images to a webhook, which can be used to store images, or to send them to a user.
- **S3 Support**: The server can be configured to upload images to an S3-compatible object store, and return the S3 URL in the response, or to return 202 immediately and upload the images to S3 in the background.
- **Easily Submit Images**: The server can accept images as base64-encoded strings, http(s) urls, and s3 urls. This makes image-to-image workflows much easier to use.
- **Warmup Workflow**: The server can be configured to run a warmup workflow on startup, which can be used to load and warm up models, and to ensure the server is ready to accept requests.
- **Return Images In PNG (default), JPEG, or WebP**: The server can return images in PNG, JPEG, or WebP format, via a parameter in the API request. Most options supported by [sharp](https://sharp.pixelplumbing.com/) are supported.
- **Probes**: The server has two probes, `/health` and `/ready`, which can be used to check the server's health and readiness to receive traffic.
- **Dynamic Workflow Endpoints**: Automatically mount new workflow endpoints by adding conforming `.js` or `.ts` files to the `/workflows` directory in your docker image. See [below](#generating-new-workflow-endpoints) for more information. A [Claude 4 Sonnet](https://claude.ai) [prompt](./claude-endpoint-creation-prompt.md) is included to assist in automating this process.
- **Bring Your Own Models And Extensions**: Use any model or extension you want by adding them to the normal ComfyUI directories `/opt/ComfyUI/`.
- **Works Great with SaladCloud**: The server is designed to work well with SaladCloud, and can be used to host ComfyUI on the SaladCloud platform. It is likely to work well with other platforms as well.
  - **Manages Deletion Cost**: *ONLY ON SALAD*. The server will automatically set the instance deletion cost to the queue length, so that busier nodes are less likely to be scaled in while they are processing requests.
- **Single Binary**: The server is distributed as a single binary, and can be run with no dependencies.
- **Websocket Events Via Webhook**: The server can forward ComfyUI websocket events to a configured webhook, which can be used to monitor the progress of a workflow.
- **Friendly License**: The server is distributed under the MIT license, and can be used for any purpose. All of its dependencies are also MIT or Apache 2.0 licensed, except ComfyUI itself, which is GPL-3.0 licensed.

## Probes

The server has two probes, `/health` and `/ready`.

- The `/health` probe will return a 200 status code once the warmup workflow has completed. It will stay healthy as long as the server is running, even if ComfyUI crashes.
- The `/ready` probe will also return a 200 status code once the warmup workflow has completed. It will return a 503 status code if ComfyUI is not running, such as in the case it has crashed, but is being automatically restarted. If you have set `MAX_QUEUE_DEPTH` to a non-zero value, it will return a 503 status code if ComfyUI's queue has reached the maximum depth.

Here's a markdown guide to configuring the application based on the provided config.ts file:

## API Configuration Guide

This guide provides an overview of how to configure the application using environment variables.

### Environment Variables

The following table lists the available environment variables and their default values.
For historical reasons, the default values mostly assume this will run on top of an [ai-dock](https://github.com/ai-dock/comfyui) image, but we currently provide [our own more minimal image](#prebuilt-docker-images) here in this repo.

If you are using the s3 storage functionality, make sure to set all of the appropriate environment variables for your S3 bucket, such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`. The server will automatically use these to upload images to S3.

| Variable                     | Default Value         | Description                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ALWAYS_RESTART_COMFYUI       | "false"               | If set to "true", the ComfyUI process will be automatically restarted if it exits. Otherwise, the API server will exit when ComfyUI exits.                                                                                                   |
| BASE                         | "ai-dock"             | There are different ways to load the comfyui environment for determining config values that vary with the base image. Currently only "ai-dock" has preset values. Set to empty string to not use this.                                       |
| CMD                          | "init.sh"             | Command to launch ComfyUI                                                                                                                                                                                                                    |
| COMFY_HOME                   | "/opt/ComfyUI"        | ComfyUI home directory                                                                                                                                                                                                                       |
| COMFYUI_PORT_HOST            | "8188"                | ComfyUI port number                                                                                                                                                                                                                          |
| DIRECT_ADDRESS               | "127.0.0.1"           | Direct address for ComfyUI                                                                                                                                                                                                                   |
| HOST                         | "::"                  | Wrapper host address                                                                                                                                                                                                                         |
| INPUT_DIR                    | "/opt/ComfyUI/input"  | Directory for input files                                                                                                                                                                                                                    |
| LOG_LEVEL                    | "info"                | Log level for the application. One of "trace", "debug", "info", "warn", "error", "fatal".                                                                                                                                                    |
| MARKDOWN_SCHEMA_DESCRIPTIONS | "true"                | If set to "true", the server will use the descriptions in the zod schemas to generate markdown tables in the swagger docs.                                                                                                                   |
| MAX_BODY_SIZE_MB             | "100"                 | Maximum body size in MB                                                                                                                                                                                                                      |
| MAX_BODY_SIZE_MB             | "100"                 | Maximum request body size in MB                                                                                                                                                                                                              |
| MAX_QUEUE_DEPTH              | "0"                   | Maximum number of queued requests before the readiness probe will return 503. 0 indicates no limit.                                                                                                                                          |
| MODEL_DIR                    | "/opt/ComfyUI/models" | Directory for model files                                                                                                                                                                                                                    |
| OUTPUT_DIR                   | "/opt/ComfyUI/output" | Directory for output files                                                                                                                                                                                                                   |
| PORT                         | "3000"                | Wrapper port number                                                                                                                                                                                                                          |
| PROMPT_WEBHOOK_RETRIES       | "3"                   | Number of times to retry sending a webhook for a prompt                                                                                                                                                                                      |
| STARTUP_CHECK_INTERVAL_S     | "1"                   | Interval in seconds between startup checks                                                                                                                                                                                                   |
| STARTUP_CHECK_MAX_TRIES      | "10"                  | Maximum number of startup check attempts                                                                                                                                                                                                     |
| SYSTEM_META_*                | (not set)             | Any environment variable starting with SYSTEM_META_ will be sent to the system webhook as metadata. i.e. `SYSTEM_META_batch=abc` will add `{"batch": "abc"}` to the `.metadata` field on system webhooks.                                    |
| SYSTEM_WEBHOOK_EVENTS        | (not set)             | Comma separated list of events to send to the webhook. Only selected events will be sent. If not set, no events will be sent. See [System Events](#system-events). You may also use the special value `all` to subscribe to all event types. |
| SYSTEM_WEBHOOK_URL           | (not set)             | Optionally receive via webhook the events that ComfyUI emits on websocket. This includes progress events.                                                                                                                                    |
| WARMUP_PROMPT_FILE           | (not set)             | Path to warmup prompt file (optional)                                                                                                                                                                                                        |
| WORKFLOW_DIR                 | "/workflows"          | Directory for workflow files                                                                                                                                                                                                                 |

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
   - The application retrieves available samplers and schedulers from ComfyUI itself.
   - This information is used to create Zod enums for validation.

### Additional Notes

- The application uses Zod for runtime type checking and validation of configuration values.
- The configuration includes setup for both the wrapper application and ComfyUI itself.

Remember to set these environment variables according to your specific deployment needs before running the application.

## Using Synchronously

The default behavior of the API is to return an array of base64-encoded outputs in the response body. All that is needed to do this is to omit the `.webhook` and `.s3` field in the request body.

## Using with Webhooks

ComfyUI API sends two types of webhooks: System Events, which are emitted by ComfyUI itself, and Workflow Events, which are emitted by the API server. See [System Events](#system-events) for more information on System Events.

If a user includes the `.webhook` field in a request to `/prompt` or any of the workflow endpoints, the server will send any completed outputs to the webhook URL provided in the request. It will also send a webhook if the request fails.

For successful requests, every output from the workflow will be sent as individual webhook requests. That means if your request generates 4 images, you will receive 4 webhook requests, each with a single image.

### output.complete

The webhook event name for a completed output is `output.complete`. The webhook will have the following schema:

```json
{
  "event": "output.complete",
  "image": "base64-encoded-image",
  "id": "request-id",
  "filename": "output-filename.png",
  "prompt": {}
}
```

### prompt.failed

The webhook event name for a failed request is `prompt.failed`. The webhook will have the following schema:

```json
{
  "event": "prompt.failed",
  "error": "error-message",
  "id": "request-id",
  "prompt": {}
}
```

## Using with S3

You must provide the necessary AWS environment variables for the API to be able to upload images to S3. These include `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`. The API will use these to upload images to the specified S3 bucket and prefix in the request body.

To use S3 to store the outputs of your workflows, you can set the `.s3` field in the request body to an object with the following schema:

```json
{
  "bucket": "your-s3-bucket-name",
  "prefix": "prefix-for-outputs-from-this-request",
  "async": false
}
```

The `bucket` field is the name of the S3 bucket to upload the outputs to, and the `prefix` field is an optional prefix to add to the output filenames. The `async` field is a boolean that determines whether the API should return a 202 response immediately, or wait for the uploads to complete before returning a response.

If `async` is set to `true`, the API will return a 202 response immediately, and the outputs will be uploaded to S3 in the background. You will need to poll S3 or configure bucket events to be notified when the uploads are complete.

If `async` is set to `false`, the API will wait for the uploads to complete before returning a response. The response will include the S3 URLs of the uploaded outputs in the `.images` field, which will be an array of strings.

## System Events

ComfyUI emits a number of events over websocket during the course of a workflow. These can be configured to be sent to a webhook using the `SYSTEM_WEBHOOK_URL` and `SYSTEM_WEBHOOK_EVENTS` environment variables. Additionally, any environment variable starting with `SYSTEM_META_` will be sent as metadata with the event.

All webhooks have the same format, which is as follows:

```json
{
  "event": "event_name",
  "data": {},
  "metadata": {}
}
```

When running on SaladCloud, `.metadata` will always include `salad_container_group_id` and `salad_machine_id`.

The following events are available:

- "status"
- "progress"
- "executing"
- "execution_start"
- "execution_cached"
- "executed"
- "execution_success"
- "execution_interrupted"
- "execution_error"

The `SYSTEM_WEBHOOK_EVENTS` environment variable should be a comma-separated list of the events you want to send to the webhook. If not set, no events will be sent.

The event name received in the webhook will be `comfy.${event_name}`, i.e. `comfy.progress`.

**Example**:

```shell
export SYSTEM_WEBHOOK_EVENTS="progress,execution_start,execution_success,execution_error"
```

This will cause the API to send the `progress`, `execution_start`, `execution_success`, and `execution_error` events to the webhook.

The `SYSTEM_META_*` environment variables can be used to add metadata to the webhook events. For example:

```shell
export SYSTEM_META_batch=abc
export SYSTEM_META_purpose=testing
```

Will add `{"batch": "abc", "purpose": "testing"}` to the `.metadata` field on system webhooks.

The following are the schemas for the event data that will be sent to the webhook. This will populate the `.data` field on the webhook.

### status

```json
{
  "type": "status",
  "data": {
    "status": {
      "exec_info": {
        "queue_remaining": 3
      }
    }
  },
  "sid": "abc123"
}
```

### progress

```json
{
  "type": "progress",
  "data": {
    "value": 45,
    "max": 100,
    "prompt_id": "123e4567-e89b-12d3-a456-426614174000",
    "node": "42"
  },
  "sid": "xyz789"
}
```

### executing

```json
{
  "type": "executing",
  "data": {
    "node": "42",
    "display_node": "42",
    "prompt_id": "123e4567-e89b-12d3-a456-426614174000"
  },
  "sid": "xyz789"
}
```

### execution_start

```json
{
  "type": "execution_start",
  "data": {
    "prompt_id": "123e4567-e89b-12d3-a456-426614174000",
    "timestamp": 1705505423000
  },
  "sid": "xyz789"
}
```

### execution_cached

```json
{
  "type": "execution_cached",
  "data": {
    "nodes": ["42", "7", "13"],
    "prompt_id": "123e4567-e89b-12d3-a456-426614174000",
    "timestamp": 1705505423000
  },
  "sid": "xyz789"
}
```

### executed

```json
{
  "type": "executed",
  "data": {
    "node": "42",
    "display_node": "42",
    "output": {},
    "prompt_id": "123e4567-e89b-12d3-a456-426614174000"
  },
  "sid": "xyz789"
}
```

### execution_success

```json
{
  "type": "execution_success",
  "data": {
    "prompt_id": "123e4567-e89b-12d3-a456-426614174000",
    "timestamp": 1705505423000
  },
  "sid": "xyz789"
}
```

### execution_interrupted

```json
{
  "type": "execution_interrupted",
  "data": {
    "prompt_id": "123e4567-e89b-12d3-a456-426614174000",
    "node_id": "42",
    "node_type": "KSampler",
    "executed": []
  },
  "sid": "xyz789"
}
```

### execution_error

```json
{
  "type": "execution_error",
  "data": {
    "prompt_id": "123e4567-e89b-12d3-a456-426614174000",
    "node_id": "42",
    "node_type": "KSampler",
    "executed": [],
    "exception_message": "CUDA out of memory. Tried to allocate 2.20 GiB",
    "exception_type": "RuntimeError",
    "traceback": "Traceback (most recent call last):\n  File \"nodes.py\", line 245, in sample\n    samples = sampler.sample(model, noise, steps)",
    "current_inputs": {
      "seed": 42,
      "steps": 20,
      "cfg": 7.5,
      "sampler_name": "euler"
    },
    "current_outputs": []
  },
  "sid": "xyz789"
}
```

## Generating New Workflow Endpoints

Since the ComfyUI prompt format is a little obtuse, it's common to wrap the workflow endpoints with a more user-friendly interface.

This can be done by adding conforming `.js` or `.ts` files to the `/workflows` directory in your dockerfile.
You can see some examples in [`./workflows`](./workflows/).
Typescript files will be automatically transpiled to javascript files, so you can use either.

Endpoints are loaded at runtime via `eval` in the context of `src/workflows`, so you can use any Node.js or TypeScript features you want, including importing other files such as the API config object.
By loading extra endpoints this way, no rebuild is required to add new endpoints, and you can continue using the pre-built binary.
You can see many examples of this in the [Salad Recipes](https://github.com/SaladTechnologies/salad-recipes/tree/master/src) repo, where this API powers all of the ComfyUI recipes.

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
type ComfyPrompt = Record<string, ComfyNode>;

interface Workflow {
  RequestSchema: z.ZodObject<any, any>;
  generateWorkflow: (input: any) => Promise<ComfyPrompt> | ComfyPrompt;
  description?: string;
  summary?: string;
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

### Automating with Claude 4 Sonnet

> **Note**: This requires having an account with Anthropic, and your anthropic API key in the environment variable `ANTHROPIC_API_KEY`.

Creating these endpoints can be done mostly automatically by [Claude 4 Sonnet](https://console.anthropic.com/), given the JSON prompt graph.
A [system prompt](./claude-endpoint-creation-prompt.md) to do this is included in this repository, as is [a script that uses this prompt](./generate-workflow) to create endpoints. It requires `jq` and `curl` to be installed.

```shell
./generate-workflow <inputFile> <outputFile>
```

Where `<inputFile>` is the JSON prompt graph, and `<outputFile>` is the output file to write the generated workflow to.

As with all AI-generated code, it is strongly recommended to review the generated code before using it in production.

## Prebuilt Docker Images

You can find ready-to-go docker images under [Packages](https://github.com/orgs/SaladTechnologies/packages?repo_name=comfyui-api) in this repository.

The images are tagged with the comfyui-api version they are built with, and the comfyui version they are built for, along with their pytorch version and CUDA version. There are versions for both CUDA runtime and CUDA devel, so you can choose the one that best fits your needs.

The tag pattern is `ghcr.io/saladtechnologies/comfyui-api:comfy<comfy-version>-api<api-version>-torch<pytorch-version>-cuda<cuda-version>-<runtime|devel>` where:

- `<comfy-version>` is the version of ComfyUI used
- `<api-version>` is the version of the comfyui-api server
- `<pytorch-version>` is the version of PyTorch used
- `<cuda-version>` is the version of CUDA used
- `<runtime|devel>` is whether the image is built with the CUDA runtime or the CUDA devel image. The devel image is much larger, but includes the full CUDA toolkit, which is required for some custom nodes.

**If the tag doesn't have `api<api-version>`, it does not include the api, and is just the ComfyUI base image.**

Included in the API images are the following utilities:

- `git`
- `curl`
- `wget`
- `unzip`
- `ComfyUI`
- `comfy` cli

All of SaladCloud's image and video generation [recipes](https://docs.salad.com/products/recipes/overview) are built on top of these images, so you can use them as a base for your own workflows. For examples of using this with custom models and nodes, check out the [Salad Recipes](https://github.com/SaladTechnologies/salad-recipes/tree/master/src) repository on GitHub.

## Considerations for Running on SaladCloud

- **SaladCloud's Container Gateway has a 100s timeout.** It is possible to construct very long running ComfyUI workflows, such as for video generation, that would exceed this timeout. In this scenario, you will need to either use a webhook to receive the results, or integrate with SaladCloud's [Job Queues](https://docs.salad.com/products/sce/job-queues/job-queues#job-queues) to handle long-running workflows.
- **SaladCloud's maximum container image size is 35GB(compressed).** The base [comfyui-api image](https://github.com/SaladTechnologies/comfyui-api/pkgs/container/comfyui-api) is around 3.25GB(compressed), so any models and extensions must fit in the remaining space.

## Contributing

Contributions are welcome!
ComfyUI is a powerful tool with MANY options, and it's likely that not all of them are currently supported by the `comfyui-api` server.
Please open an issue with as much information as possible about the problem you're facing or the feature you need.
If you have encountered a bug, please include the steps to reproduce it, and any relevant logs or error messages.
If you are able, adding a failing test is the best way to ensure your issue is resolved quickly.
Let's make productionizing ComfyUI as easy as possible!

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
- `THUDM/CogVideoX-2b` - https://huggingface.co/THUDM/CogVideoX-2b
- `mochi_preview_fp8_scaled.safetensors` - https://huggingface.co/Comfy-Org/mochi_preview_repackaged/blob/main/all_in_one/mochi_preview_fp8_scaled.safetensors
- `oldt5_xxl_fp8_e4m3fn_scaled.safetensors` - https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/tree/main/text_encoders
- `cosmos_cv8x8x8_1.0.safetensors` - https://huggingface.co/comfyanonymous/cosmos_1.0_text_encoder_and_VAE_ComfyUI/blob/main/vae/cosmos_cv8x8x8_1.0.safetensors
- `Cosmos-1_0-Diffusion-7B-Text2World.safetensors` - https://huggingface.co/mcmonkey/cosmos-1.0/blob/main/Cosmos-1_0-Diffusion-7B-Text2World.safetensors


They should be in the correct comfyui directory structure, like so:

```text
./test/docker-image/models
├── animatediff_models
│   └── AnimateLCM_sd15_t2v.ckpt
├── checkpoints
│   ├── dreamshaper_8.safetensors
│   ├── flux1-schnell-fp8.safetensors
│   ├── ltx-video-2b-v0.9.1.safetensors
|   ├── mochi_preview_fp8_scaled.safetensors
│   ├── sd3.5_medium.safetensors
│   ├── sd_xl_base_1.0.safetensors
│   └── sd_xl_refiner_1.0.safetensors
├── clip
│   ├── clip_g.safetensors
│   ├── clip_l.safetensors
│   ├── t5xxl_fp16.safetensors
│   └── t5xxl_fp8_e4m3fn.safetensors
├── CogVideo
│   └── CogVideo2B/
├── controlnet
│   ├── openpose-sd1.5-1.1.safetensors
├── diffusion_models
│   ├── hunyuan_video_t2v_720p_bf16.safetensors
|   └── Cosmos-1_0-Diffusion-7B-Text2World.safetensors
├── loras
│   ├── jump_V2.safetensors
├── text_encoders
│   ├── clip_l.safetensors
│   ├── llava_llama3_fp8_scaled.safetensors
|   └── oldt5_xxl_fp8_e4m3fn_scaled.safetensors
├── vae
│   ├── hunyuan_video_vae_bf16.safetensors
│   ├── vae-ft-mse-840000-ema-pruned.ckpt
│   └── cosmos_cv8x8x8_1.0.safetensors
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

## Architecture

The server is built with [Fastify](https://www.fastify.io/), a fast and low overhead web framework for Node.js.
It sits in front of ComfyUI, and provides a RESTful API for interacting with ComfyUI.

![Architecture Diagram](./ComfyUI%20API%20Diagram.png)