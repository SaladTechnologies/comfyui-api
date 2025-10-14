# ComfyUI API - A Stateless and Extendable API for ComfyUI

A simple wrapper that facilitates using [ComfyUI](https://github.com/comfyanonymous/ComfyUI/) as a stateless API, either by receiving images in the response, or by sending completed images to a webhook

- [ComfyUI API - A Stateless and Extendable API for ComfyUI](#comfyui-api---a-stateless-and-extendable-api-for-comfyui)
  - [Download and Use](#download-and-use)
  - [Features](#features)
  - [Full ComfyUI Support](#full-comfyui-support)
  - [Stateless API](#stateless-api)
    - [Request Format](#request-format)
    - [Response Format](#response-format)
  - [Model Manifest](#model-manifest)
  - [Downloading Behavior](#downloading-behavior)
  - [Modular Storage Backends](#modular-storage-backends)
    - [S3-Compatible Storage](#s3-compatible-storage)
    - [Huggingface Repository](#huggingface-repository)
    - [Azure Blob Storage](#azure-blob-storage)
    - [HTTP](#http)
  - [Image To Image Workflows](#image-to-image-workflows)
  - [Dynamic Model Loading](#dynamic-model-loading)
  - [Server-side image processing](#server-side-image-processing)
  - [Probes](#probes)
  - [API Configuration Guide](#api-configuration-guide)
    - [Environment Variables](#environment-variables)
    - [Configuration Details](#configuration-details)
    - [Additional Notes](#additional-notes)
  - [Using Synchronously](#using-synchronously)
  - [Using with Webhooks](#using-with-webhooks)
    - [output.complete](#outputcomplete)
    - [prompt.failed](#promptfailed)
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
  - [Prebuilt Docker Images](#prebuilt-docker-images)
  - [Considerations for Running on SaladCloud](#considerations-for-running-on-saladcloud)
  - [Custom Workflows](#custom-workflows)
  - [Contributing](#contributing)
  - [Architecture](#architecture)

## Download and Use

Either use a [pre-built Docker image](#prebuilt-docker-images), or build your own.

Download the latest version from the release page, and copy it into your existing ComfyUI dockerfile.
You can find good base dockerfiles in the [docker](./docker) directory.
There are also example dockerfiles for popular models in the [SaladCloud Recipes Repo](https://github.com/SaladTechnologies/salad-recipes/tree/master/src).

If you have your own ComfyUI dockerfile, you can add the comfyui-api server to it like so:

```dockerfile
# Change this to the version you want to use
ARG api_version=1.11.0

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
- **"Synchronous" Support**: The server will return base64-encoded images directly in the response, if no async behavior is requested.
- **Modular Storage Backends**: Completed outputs can be sent base64-encoded to a webhook, or uploaded to any s3-compatible storage, an http endpoint, a huggingface repo, or azure blob storage. All of these can be used to download input media as well. More storage backends can be added easily.
- **Warmup Workflow**: The server can be configured to run a warmup workflow on startup, which can be used to load and warm up models, and to ensure the server is ready to accept requests.
- **Return Images In PNG (default), JPEG, or WebP**: The server can return images in PNG, JPEG, or WebP format, via a parameter in the API request. Most options supported by [sharp](https://sharp.pixelplumbing.com/) are supported.
- **Probes**: The server has two probes, `/health` and `/ready`, which can be used to check the server's health and readiness to receive traffic.
- **Dynamic Workflow Endpoints**: Automatically mount new workflow endpoints by adding conforming `.js` or `.ts` files to the `/workflows` directory in your docker image. See [the guide](./DEVELOPING.md#generating-new-workflow-endpoints) for more information. A [Claude 4 Sonnet](https://claude.ai) [prompt](./claude-endpoint-creation-prompt.md) is included to assist in automating this process.
- **Bring Your Own Models And Extensions**: Use any model or extension you want by adding them to the normal ComfyUI directories `/opt/ComfyUI/`. You can configure a [manifest file](#model-manifest) to download models and install extensions automatically on startup.
- **Dynamic Model Loading**: If you provide a URL in a model-loading node, the server will locally cache the model automatically before executing the workflow.
- **Execution Stats**: The server will return [execution stats in the response](#response-format).
- **Works Great with SaladCloud**: The server is designed to work well with SaladCloud, and can be used to host ComfyUI on the SaladCloud platform. It is likely to work well with other platforms as well.
  - **Manages Deletion Cost**: _ONLY ON SALAD_. The server will automatically set the instance deletion cost to the queue length, so that busier nodes are less likely to be scaled in while they are processing requests.
- **Single Binary**: The server is distributed as a single binary, and can be run with no dependencies.
- **Websocket Events Via Webhook**: The server can forward ComfyUI websocket events to a configured webhook, which can be used to monitor the progress of a workflow.
- **Friendly License**: The server is distributed under the MIT license, and can be used for any purpose. All of its dependencies are also MIT or Apache 2.0 licensed, except ComfyUI itself, which is GPL-3.0 licensed.

## Full ComfyUI Support

ComfyUI API sits in front of ComfyUI, and uses the ComfyUI `/prompt` API to execute workflows, so any API-formatted prompt can be executed by the server. Before queueing the prompt, the server will download any required inputs, such as images. It also overrides the `filename_prefix` field in the prompt to ensure that output files are saved with a unique filename. Once the prompt is queued, the server will wait for the prompt to complete, and then return the outputs in the response body, via a webhook, or upload them to S3, depending on the request parameters. Because of this, anything you can run in ComfyUI can be run in the ComfyUI API server, including custom nodes and workflows, and any models ComfyUI supports.

## Stateless API

The ComfyUI API server is designed to be stateless, meaning that it does not store any state between requests. This allows the server to be scaled horizontally behind a load balancer, and to handle more requests by adding more instances of the server. The server uses a configurable warmup workflow to ensure that ComfyUI is ready to accept requests, and to load any required models. The server also self-hosts swagger docs and an openapi spec at `/docs`, which can be used to interact with the API.

### Request Format

Prompts are submitted to the server via the `POST /prompt` endpoint, which accepts a JSON body containing the prompt graph, as well as any additional parameters such as the webhook URL, S3 bucket and prefix, and image conversion options. A request may look something like:

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "prompt": {
    "1": {
      "inputs": {
        "image": "https://salad-benchmark-assets.download/coco2017/train2017/000000000009.jpg",
        "upload": "image"
      },
      "class_type": "LoadImage"
    }
  },
  "webhook": "https://example.com/webhook",
  "convert_output": {
    "format": "jpeg",
    "options": {
      "quality": 80,
      "progressive": true
    }
  }
}
```

- Only the `prompt` field is required. The other fields are optional, and can be omitted if not needed.
- Your prompt must be a valid ComfyUI prompt graph, which is a JSON object where each key is a node ID, and the value is an object containing the node's inputs, class type, and optional metadata.
- Your prompt must include a node that saves an output, such as a `SaveImage` node.

### Response Format

For async requests (i.e. when a webhook or S3 upload is used), the server will return a `202 Accepted` response immediately, and the outputs will be sent to the webhook or uploaded to S3 in the background.

For synchronous requests (i.e. no webhook or s3.async is false), the server will return a `200 OK` response once the prompt has completed, with a body containing the outputs. The response body will have the following format:

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "prompt": { ... },
  "images": [
    "base64-encoded-image-1",
    "base64-encoded-image-2"
  ],
  "filenames": [
    "output-filename-1.png",
    "output-filename-2.png"
  ],
  "stats": {
    "comfy_execution": {
      "total": {
        "start": 1625247600000,
        "end": 1625247605000,
        "duration": 5000
      },
      "nodes": {
        "1": {
          "start": 1625247600000
        },
        "2": {
          "start": 1625247601000
        }
      }
    },
    "preprocess_time": 1500,
    "upload_time": 1,
    "total_time": 6576
  }
}
```

If you requested image conversion, the images will be in the requested format (e.g. JPEG or WebP) instead of PNG.

## Model Manifest

The server can be configured to download models and install extensions automatically on startup, by providing a manifest file in either JSON or YAML format. The manifest filepath can be provided via the `MANIFEST` environment variable, or the full manifest as a JSON string via the `MANIFEST_JSON` environment variable. If both are provided, the `MANIFEST_JSON` variable will take precedence.

The manifest file should have the following format (all fields are optional):

```yaml
apt:
  - package1
  - package2
pip:
  - package3
  - package4
custom_nodes:
  - node-name-from-comfy-registry
  - https://github.com/username/repo
models:
  before_start:
    - url: https://example.com/model.ckpt
      local_path: /opt/ComfyUI/models/checkpoints/model1.ckpt
    - url: s3://my-bucket/path/to/model.safetensors
      local_path: /opt/ComfyUI/models/checkpoints/model2.safetensors
  after_start:
    - url: https://example.com/another-model.ckpt
      local_path: /opt/ComfyUI/models/checkpoints/model3.ckpt
```

If a manifest is provided, the server will perform the following in order:

1. Install any apt packages listed in the `apt` field.
2. Install any pip packages listed in the `pip` field. Uses `uv`, otherwise falls back to `pip`.
3. Install any custom nodes listed in the `custom_nodes` field, using the `comfy` cli tool if available and a plain string is provided, or by cloning the provided git repository if a URL is provided. If cloned, `requirements.txt` will be installed if it exists, using `uv` if available, otherwise falling back to `pip`.
4. Download any models listed in the `models.before_start` field, and save them to the specified `local_path`.
5. Start background downloading any models listed in the `models.after_start` field, and save them to the specified `local_path`. These downloads will be started in the background and will not block the server from accepting requests. This is useful for preloading less frequently used models.

## Downloading Behavior

When downloading files, whether via the manifest, image-to-image workflows, or dynamic model loading, the server will first check if the file already exists at the specified path.
It does this by hashing the provided URL and looking for a matching file in the cache directory (`$HOME/.cache/comfyui-api` by default).
For example, the url `https://civitai.com/api/download/models/128713?type=Model&format=SafeTensor&size=pruned&fp=fp16` will always be saved in the cache as `Pk6VSKLStckZydwGhX0bM8TqaqHEW9yt.safetensors`.
If a matching file is found, it will be used instead of downloading the file again.
This helps to reduce bandwidth usage and speed up request times.

If the url is an S3 URL, the server will use the AWS SDK to download the file.
This allows the server to access private S3 buckets (or S3-compatible buckets), as long as the appropriate AWS credentials are provided via environment variables.

If the url is a huggingface URL, the server will use the `hf` cli tool to download the file.
This allows you to take advantage of high-speed [xet storage](https://huggingface.co/docs/hub/en/storage-backends#xet), as well as other optimizations provided by huggingface.

If the url is an azure blob storage URL, the server will use the Azure SDK to download the file.

If the url is a regular http(s) URL, the server will use `fetch` to stream the file to disk.
If the url has a file extension, the server will use that extension when saving the file.
Otherwise, it will attempt to determine the file extension from the `Content-Disposition` or `Content-Type` headers.

All downloaded files live in the configured cache directory with a name taken as the first 32 characters of the URL hash plus the file extension, and are symbolically linked to the specified local path.

If a download for a given URL is already in progress, any subsequent requests for the same URL will wait for the first download to complete, and then use the downloaded file.

## Modular Storage Backends

The server supports multiple storage backends for downloading models and input media, and uploading completed outputs.
All uploads take a prefix of some kind, not a full path or URL.

All uploads can be handled synchronously or asynchronously, depending on the `async` field in the upload block of the request body.

- If `async` is `true` or omitted, the server will return a `202 Accepted` response immediately, and the upload will be handled in the background.
- If `async` is `false`, the server will wait for the upload to complete before returning a `200 OK` response with the uploaded urls in the response body.

If an upload for a particular url is in progress, a subsequent upload to the same url will abort the first request and take over the upload.
This is rooted in the assumption that you want the latest version of any particular output.

### S3-Compatible Storage

Includes AWS S3, Cloudflare R2, etc.
Uses the AWS SDK. Requires appropriate AWS credentials to be provided via environment variables.
Used for URLs starting with `s3://`.

For downloads, use the format `s3://bucket-name/path/to/file`.
For uploads, include the `s3` field in the request body, like:

```json
{
  "prompt": {...}, 
  "s3": { 
    "bucket": "my-bucket", 
    "prefix": "optional/prefix", 
    "async": false 
  }
}
```

### Huggingface Repository

Uses the `hf` cli tool.
Requires the `HF_TOKEN` environment variable to be set with a valid Huggingface token.
Used for URLs starting with `https://huggingface.co/`.
Works with both public and private repos, model and dataset repos, and large files stored with [xet storage](https://huggingface.co/docs/hub/en/storage-backends#xet).

For downloads, use the format `https://huggingface.co/username/repo/resolve/revision/path/to/file` or `https://huggingface.co/datasets/username/repo/resolve/revision/path/to/file`.

For uploads, include the `hf_upload` field in the request body, like 

```json
{
  "prompt": {}, 
  "hf_upload": { 
    "repo": "username/repo", 
    "repo_type": "dataset", 
    "revision": "main", 
    "directory": "test-source-images", 
    "async": false 
  }
}
```

The `repo_type` field can be either `model` or `dataset`, and defaults to `model`.

### Azure Blob Storage

Uses the Azure SDK.
Requires appropriate Azure credentials to be provided via environment variables.
Used for URLs matching `https://<your-account>.blob.core.windows.net/`.

For downloads, use the format `https://<your-account>.blob.core.windows.net/container/path/to/file`.

For uploads, include the `azure_blob_upload` field in the request body, like:

```json
{
  "prompt": {}, 
  "azure_blob_upload": { 
    "container": "my-container", 
    "blob_prefix": "optional/prefix", 
    "async": false 
  }
}
```

### HTTP

Uses Fetch.
Supports custom headers via the `HTTP_AUTH_HEADER_NAME` and `HTTP_AUTH_HEADER_VALUE` environment variables.
Basic auth can be used via the URL, i.e. `https://username:password@your-http-endpoint.com`.

For downloads, use any valid http(s) URL that is not matched by the other storage backends.

For uploads, makes a PUT request to the specified URL with the image as the body.  Matches any other URL not matched by the other storage backends.

## Image To Image Workflows

The ComfyUI API server supports image-to-image workflows, allowing you to submit an image and receive a modified version of that image in response.
This is useful for tasks such as image in-painting, style transfer, and other image manipulation tasks.

To use image-to-image workflows, you can submit an image as a base64-encoded string, or a URL.
The server will automatically detect the input type and process the image accordingly, using an appropriate storage provider if necessary.

Here's an example of doing this in a `LoadImage` node:

```json
{
  "inputs": {
    "image": "https://salad-benchmark-assets.download/coco2017/train2017/000000000009.jpg",
    "upload": "image"
  },
  "class_type": "LoadImage",
  "_meta": {
    "title": "Load Image"
  }
}
```

## Dynamic Model Loading

The ComfyUI API server supports dynamic model loading, allowing you to specify a model URL in a model-loading node, and the server will automatically download and cache the model before executing the workflow.
This is useful for workflows that need to potentially use a different model for each request.
An example may be head-shot generation, which would specify a LoRA per person.
The LoRA may be generated on-the-fly by another service, and provided to the ComfyUI API server via a URL.

```json
{
  "inputs": {
    "ckpt_name": "https://civitai.com/api/download/models/76750?type=Model&format=SafeTensor&size=pruned&fp=fp16"
  },
  "class_type": "CheckpointLoaderSimple",
  "_meta": {
    "title": "Load Checkpoint"
  }
},
```

## Server-side image processing

The ComfyUI API server uses the [sharp](https://sharp.pixelplumbing.com/) library to process images. This allows you to return the images in different, more compact formats, such as JPEG or WebP. This can be accomplished by including the `convert_output` object in the request body, which can contain the following fields:

```json
{
  "format": "jpeg|webp",
  "options": {}
}
```

Omitting the `convert_output` object will default to PNG format, which is lossless and has the best quality, but is also the largest in size.

**JPEG options**:

- `quality`: The quality of the JPEG image, between 1 and 100. Default is `80`.
- `progressive`: Use progressive (interlace) scanning. Default is `false`.
- `chromaSubsampling`: Set to `4:4:4` to prevent chroma subsampling otherwise defaults to `4:2:0` chroma subsampling.
- `optimizeCoding`: Optimize the Huffman coding tables. Default is `true`.
- `mozjpeg`: use mozjpeg defaults, equivalent to `{ trellisQuantisation: true, overshootDeringing: true, optimizeScans: true, quantisationTable: 3 }`
- `trellisQuantisation`: Use trellis quantization. Default is `false`.
- `overshootDeringing`: Use overshoot deringing. Default is `false`.
- `optimizeScans`: Optimize the scan order. Default is `false`.
- `quantisationTable`: Set the quantization table to use, 1 - 8. Default is `0`.

**WebP options**:

- `quality`: The quality of the WebP image, between 1 and 100. Default is `80`.
- `alphaQuality`: The quality of the alpha channel, between 0 and 100. Default is `100`.
- `lossless`: Use lossless compression. Default is `false`.
- `nearLossless`: Use near-lossless compression. Default is `false`.
- `smartSubsample`: Use smart subsampling. Default is `false`.
- `preset`: named preset for preprocessing/filtering, one of `default`, `picture`, `photo`, `drawing`, `icon`, or `text`. Default is `default`.
- `effort`: CPU effort level, between 0 (fastest) and 6 (slowest). Default is `4`.

## Probes

The server has two probes, `/health` and `/ready`.

- The `/health` probe will return a 200 status code once the warmup workflow has completed. It will stay healthy as long as the server is running, even if ComfyUI crashes.
- The `/ready` probe will also return a 200 status code once the warmup workflow has completed. It will return a 503 status code if ComfyUI is not running, such as in the case it has crashed, but is being automatically restarted. If you have set `MAX_QUEUE_DEPTH` to a non-zero value, it will return a 503 status code if ComfyUI's queue has reached the maximum depth.

## API Configuration Guide

### Environment Variables

The following table lists the available environment variables and their default values.
For historical reasons, the default values mostly assume this will run on top of an [ai-dock](https://github.com/ai-dock/comfyui) image, but we currently provide [our own more minimal image](#prebuilt-docker-images) here in this repo.

If you are using the s3 storage functionality, make sure to set all of the appropriate environment variables for your S3 bucket, such as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`.
The server will automatically use these to upload images to S3.

If you are using the huggingface storage functionality, make sure to set the `HF_TOKEN` environment variable with a valid Huggingface token with appropriate permissions.

If you are using the azure blob storage functionality, make sure to set all of the appropriate environment variables for your Azure account, such as `AZURE_STORAGE_CONNECTION_STRING`.

| Variable                     | Default Value              | Description                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ALWAYS_RESTART_COMFYUI       | "false"                    | If set to "true", the ComfyUI process will be automatically restarted if it exits. Otherwise, the API server will exit when ComfyUI exits.                                                                                                   |
| BASE                         | (not set)                  | There are different ways to load the comfyui environment for determining config values that vary with the base image. Currently only "ai-dock" has a special preset value.                                                                   |
| CACHE_DIR                    | "$HOME/.cache/comfyui-api" | Directory to use for caching downloaded models and other files.                                                                                                                                                                              |
| CMD                          | "init.sh"                  | Command to launch ComfyUI                                                                                                                                                                                                                    |
| COMFY_HOME                   | "/opt/ComfyUI"             | ComfyUI home directory                                                                                                                                                                                                                       |
| COMFYUI_PORT_HOST            | "8188"                     | ComfyUI port number                                                                                                                                                                                                                          |
| DIRECT_ADDRESS               | "127.0.0.1"                | Direct address for ComfyUI                                                                                                                                                                                                                   |
| HOST                         | "::"                       | Wrapper host address                                                                                                                                                                                                                         |
| HTTP_AUTH_HEADER_NAME        | (not set)                  | If set, the server will include this header name with the value from HTTP_AUTH_HEADER_VALUE in all outgoing HTTP requests for uploading and downloading files. This can be used to add basic auth or bearer tokens to requests.              |
| HTTP_AUTH_HEADER_VALUE       | (not set)                  | The value to use for the HTTP_AUTH_HEADER_NAME header in all outgoing HTTP requests for uploading and downloading files.                                                                                                                     |
| INPUT_DIR                    | "/opt/ComfyUI/input"       | Directory for input files                                                                                                                                                                                                                    |
| LOG_LEVEL                    | "info"                     | Log level for the application. One of "trace", "debug", "info", "warn", "error", "fatal".                                                                                                                                                    |
| MANIFEST                     | (not set)                  | Path to the [manifest file](#model-manifest) (optional). Can be yml or json.                                                                                                                                                                 |
| MANIFEST_JSON                | (not set)                  | A JSON string representing the [manifest](#model-manifest). If set, this will take precedence over the MANIFEST variable.                                                                                                                    |
| MARKDOWN_SCHEMA_DESCRIPTIONS | "true"                     | If set to "true", the server will use the descriptions in the zod schemas to generate markdown tables in the swagger docs.                                                                                                                   |
| MAX_BODY_SIZE_MB             | "100"                      | Maximum body size in MB                                                                                                                                                                                                                      |
| MAX_BODY_SIZE_MB             | "100"                      | Maximum request body size in MB                                                                                                                                                                                                              |
| MAX_QUEUE_DEPTH              | "0"                        | Maximum number of queued requests before the readiness probe will return 503. 0 indicates no limit.                                                                                                                                          |
| MODEL_DIR                    | "/opt/ComfyUI/models"      | Directory for model files                                                                                                                                                                                                                    |
| OUTPUT_DIR                   | "/opt/ComfyUI/output"      | Directory for output files                                                                                                                                                                                                                   |
| PORT                         | "3000"                     | Wrapper port number                                                                                                                                                                                                                          |
| PREPEND_FILENAMES            | "true"                     | If set to "true", the server will prepend a unique identifier to output filenames to avoid collisions. Otherwise, the server will overwrite filename prefixes with the unique identifier (legacy behavior).                                  |
| PROMPT_WEBHOOK_RETRIES       | "3"                        | Number of times to retry sending a webhook for a prompt                                                                                                                                                                                      |
| STARTUP_CHECK_INTERVAL_S     | "1"                        | Interval in seconds between startup checks                                                                                                                                                                                                   |
| STARTUP_CHECK_MAX_TRIES      | "20"                       | Maximum number of startup check attempts                                                                                                                                                                                                     |
| SYSTEM_META\_\*              | (not set)                  | Any environment variable starting with SYSTEM*META* will be sent to the system webhook as metadata. i.e. `SYSTEM_META_batch=abc` will add `{"batch": "abc"}` to the `.metadata` field on system webhooks.                                    |
| SYSTEM_WEBHOOK_EVENTS        | (not set)                  | Comma separated list of events to send to the webhook. Only selected events will be sent. If not set, no events will be sent. See [System Events](#system-events). You may also use the special value `all` to subscribe to all event types. |
| SYSTEM_WEBHOOK_URL           | (not set)                  | Optionally receive via webhook the events that ComfyUI emits on websocket. This includes progress events.                                                                                                                                    |
| WARMUP_PROMPT_FILE           | (not set)                  | Path to warmup prompt file (optional)                                                                                                                                                                                                        |
| WORKFLOW_DIR                 | "/workflows"               | Directory for workflow files                                                                                                                                                                                                                 |

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
   - The application retrieves available samplers and schedulers from ComfyUI itself at startup. It does not take custom nodes or extensions into account.
   - This information is used to create Zod enums for validation in workflows, but is otherwise not used by the application.

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

## Custom Workflows

Custom workflows offer a simple and powerful way to create new endpoints for your specific use cases which abstract away the complexities of the underlying ComfyUI node-based prompt format.
You can create workflows in either javascript or typescript, and they can be as simple or complex as you need them to be.
Workflows are loaded at runtime, even when you use the pre-compiled binary releases or docker images, so you can easily add new workflows without needing to rebuild the image.

[See the guide on generating new workflow endpoints](./DEVELOPING.md#generating-new-workflow-endpoints) for more information.

## Contributing

Contributions are welcome!
See the [Development](./DEVELOPMENT.md) guide for more information on how to develop, test, and contribute to this project.
ComfyUI is a powerful tool with MANY options, and it's likely that not all of them are currently well supported by the `comfyui-api` server.
Please open an issue with as much information as possible about the problem you're facing or the feature you need.
If you have encountered a bug, please include the steps to reproduce it, and any relevant logs or error messages.
If you are able, adding a failing test is the best way to ensure your issue is resolved quickly.
Let's make productionizing ComfyUI as easy as possible!

## Architecture

The server is built with [Fastify](https://www.fastify.io/), a fast and low overhead web framework for Node.js.
It sits in front of ComfyUI, and provides a RESTful API for interacting with ComfyUI.

![Architecture Diagram](./ComfyUI%20API%20Diagram.png)
