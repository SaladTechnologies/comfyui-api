# Developing ComfyUI-API

This document provides guidelines for developers who want to contribute to the ComfyUI-API project.
It covers setting up the development environment, coding standards, testing procedures, and how to submit contributions.

- [Developing ComfyUI-API](#developing-comfyui-api)
  - [Submitting Contributions](#submitting-contributions)
  - [Core Design Principles](#core-design-principles)
  - [Setting Up the Development Environment](#setting-up-the-development-environment)
  - [Testing Procedures](#testing-procedures)
    - [Running Tests](#running-tests)
  - [Generating New Workflow Endpoints](#generating-new-workflow-endpoints)
    - [Automating with Claude 4 Sonnet](#automating-with-claude-4-sonnet)
    - [Debugging Custom Workflows](#debugging-custom-workflows)
  - [Storage Providers](#storage-providers)
    - [Adding a New Storage Provider](#adding-a-new-storage-provider)

## Submitting Contributions

Contributions are welcome!
ComfyUI is a powerful tool with MANY options, and it's likely that not all of them are currently well supported by the `comfyui-api` server.
Please open an issue with as much information as possible about the problem you're facing or the feature you need.
If you have encountered a bug, please include the steps to reproduce it, and any relevant logs or error messages.
If you are able, adding a failing test is the best way to ensure your issue is resolved quickly.
Let's make productionizing ComfyUI as easy as possible!

## Core Design Principles

When contributing to the ComfyUI-API project, please keep the following design principles in mind:

- **Asynchronous Operations**: Use asynchronous programming practices wherever possible to ensure the server remains responsive. Avoid blocking the event loop.
- **Modularity**: Because the range of uses for this API is so broad, strive to keep components modular and loosely coupled. This will make it easier to add new features and maintain existing ones.
- **Don't Duplicate Existing ComfyUI functionality**: Wherever possible, leverage existing ComfyUI api endpoints and functionality, rather than re-implementing it in the API server. Local ComfyUI can be accessed from the the API server at `config.comfyURL`.
- **Error Handling**: Implement robust error handling to gracefully manage unexpected situations. Provide clear and informative error messages to users. Errors should never crash the server unless recovery is deemed impossible.
- **Testing**: If your feature or bug fix is significant, please include tests to verify its functionality. This helps maintain the integrity of the codebase.

## Setting Up the Development Environment

```shell
git clone https://github.com/SaladTechnologies/comfyui-api.git
cd comfyui-api
npm install
npm run build-binary
```

This will create a `comfyui-api` binary in the `dist/` directory, which is mounted into the Docker container when you run `docker compose up`.

Whenever you make changes, you will need to re-run `npm run build-binary` to rebuild the binary, and then restart the Docker container to see your changes.

## Testing Procedures

This project uses [mocha](https://mochajs.org/) and [earl](https://earl.fun/) for testing.
Tests are administered against a locally running instance of the ComfyUI API server, which can be started with Docker Compose, and actual images are generated during the tests.

Additional services are present in the docker-compose file to provide mock storage services for testing uploads and downloads.
These services are not required for normal operation of the API server.

### Running Tests

In one terminal, start the test server:

```shell
docker compose up --build
```

> --build is only needed the first time, or if you make changes to the file-server code.

In another terminal, run the tests:

```shell
npm run quick-test
```

This will take several minutes, but can be done with very modest hardware.
All tests in the `quick-test` suite use SD1.5 models, which are small and fast to run.
The models used are defined in [the manifest](./manifest.yml), as well in a couple [test workflows](./test/workflows/)

## Generating New Workflow Endpoints

Since the ComfyUI prompt format is a little obtuse, it's common to wrap the `/prompt` endpoint with a more user-friendly interface.

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
  checkpoint: z
    .string()
    .refine((val) => config.models.checkpoints.all.includes(val))
    .optional()
    .default(config.warmupCkpt || config.models.checkpoints.all[0])
    .describe("Checkpoint to use"),
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
        filename_prefix: "output",
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

- `POST /workflow/sdxl/img2img`
- `POST /workflow/sdxl/txt2img-with-refiner`
- `POST /workflow/sdxl/txt2img`

These endpoints will be present in the swagger docs, and can be used to interact with the API.
If you provide descriptions in your zod schemas, these will be used to create a markdown table of inputs in the swagger docs.

### Automating with Claude 4 Sonnet

> **Note**: This requires having an account with Anthropic, and your anthropic API key in the environment variable `ANTHROPIC_API_KEY`.

Creating these endpoints can be done mostly automatically by [Claude 4 Sonnet](https://console.anthropic.com/), given the JSON prompt graph.
A [system prompt](./claude-endpoint-creation-prompt.md) to do this is included in this repository, as is [a script that uses this prompt](./generate-workflow) to create endpoints. It requires `jq` and `curl` to be installed.

```shell
./generate-workflow <inputFile> <outputFile>
```

Where `<inputFile>` is the JSON prompt graph, and `<outputFile>` is the output file to write the generated workflow to.

As with all AI-generated code, it is strongly recommended to review the generated code before using it in production.

### Debugging Custom Workflows

When developing or troubleshooting custom workflows, enable debug logging to see detailed information about what's happening under the hood.

#### Enabling Debug Logging

Set the `LOG_LEVEL` environment variable to `debug`:

```shell
# Docker
docker run -e LOG_LEVEL=debug ...

# Docker Compose
environment:
  - LOG_LEVEL=debug
```

#### What Debug Logging Shows

With `LOG_LEVEL=debug`, the server will log:

1. **Workflow Loading** (at startup):
   - Which workflow directories are being scanned
   - TypeScript files being transpiled
   - Each workflow file being evaluated
   - Successfully loaded workflows
   - Warnings for files that don't export valid Workflow objects
   - Errors if workflow files fail to evaluate (with stack traces)

2. **Workflow Execution** (per request):
   - The input received from the request (`Workflow input received`)
   - The generated ComfyUI prompt (`Generated ComfyUI prompt from workflow`)
   - The full request body sent to `/prompt` (`Sending request to /prompt endpoint`)
   - Any errors from the `/prompt` endpoint (including the full prompt that failed)

#### Common Issues and Solutions

**Problem: 400 error from `/prompt` endpoint with validation errors**

Debug logs will show the exact prompt being sent. Common causes:
- Missing required nodes (e.g., no `SaveImage` node with `filename_prefix`)
- Invalid node references (e.g., referencing a node ID that doesn't exist)
- Invalid input types (e.g., string where number expected)

Check the `promptRequestBody` in the error log to see exactly what was sent.

**Problem: Workflow file not loading**

Debug logs will show if the file:
- Failed to transpile (TypeScript syntax error)
- Failed to evaluate (JavaScript runtime error)
- Doesn't export a valid Workflow object

**Problem: Workflow generates wrong output**

Use debug logs to compare:
1. The `input` received by the workflow
2. The `prompt` generated by your `generateWorkflow` function
3. Compare against a known-working prompt from ComfyUI's web interface

#### Example Debug Output

```
{"level":30,"workflow":"txt2img","msg":"Workflow input received","input":{"prompt":"a cat","width":512}}
{"level":30,"workflow":"txt2img","msg":"Generated ComfyUI prompt from workflow","prompt":{"3":{"inputs":{"seed":123...}}}}
{"level":30,"workflow":"txt2img","msg":"Sending request to /prompt endpoint","promptRequestBody":{...}}
{"level":30,"workflow":"txt2img","msg":"Workflow completed successfully","status":200}
```

When a workflow fails:
```
{"level":50,"workflow":"txt2img","msg":"Workflow request to /prompt endpoint failed","status":400,"error":"Prompt must contain a node with a \"filename_prefix\" input","location":"prompt","promptRequestBody":{...}}
```

#### Inspecting Prompts Without Debug Logging

If you can't enable debug logging, you can still inspect your generated prompts by:

1. **Using the `/docs` endpoint**: Access the Swagger UI at `http://localhost:3000/docs` to test your workflow endpoints interactively
2. **Testing generateWorkflow locally**: Import your workflow file and call `generateWorkflow()` with test inputs to see the output
3. **Comparing with ComfyUI**: Export a working prompt from ComfyUI's web interface and compare it to your generated prompt

## Storage Providers

Storage providers are modular components that handle the downloading of models and input media, as well as the uploading of completed outputs.
The ComfyUI API server supports multiple storage backends, each with its own configuration and usage.
They all live in `src/storage-providers/` and must be exported in `src/storage-providers/index.ts`.
They are defined by the `StorageProvider` interface in `src/types.ts`:

```typescript
export interface StorageProvider {
  /**
   * The key in a request body that indicates this storage provider should be used for upload.
   * Must be unique across all storage providers, and must be included if `uploadFile` is implemented.
   */
  requestBodyUploadKey?: string;

  /**
   * The zod schema for the request body field that indicates this storage provider should
   * be used for upload. Must be included if `requestBodyUploadKey` is defined.
   */
  requestBodyUploadSchema?: z.ZodObject<any, any>;

  /**
   * Takes the inputs from the request body and generates a URL for uploading.
   * @param inputs
   */
  createUrl(inputs: any): string;

  /**
   * Test if the given URL can be handled by this storage provider.
   * @param url URL to test
   */
  testUrl(url: string): boolean;

  /**
   * Upload a file to the given URL.
   * @param url URL to upload to
   * @param fileOrPath File path or buffer to upload
   * @param contentType MIME type of the file
   *
   * @returns An Upload object that can be used to start and abort the upload.
   */
  uploadFile?(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string
  ): Upload;

  /**
   * Download a file from the given URL to the specified output directory.
   * @param url URL to download from
   * @param outputDir Directory to save the downloaded file
   * @param filenameOverride Optional filename to use instead of auto-generated one
   *
   * @resolves The path to the downloaded file
   */
  downloadFile?(
    url: string,
    outputDir: string,
    filenameOverride?: string
  ): Promise<string>;
}
```

- Each storage provider must implement the `StorageProvider` interface, which includes methods for creating upload URLs, testing if a URL can be handled by the provider, uploading files, and downloading files.
- The server will automatically select the appropriate storage provider based on the URL provided in the request body, using the `testUrl` method of each provider to determine which one can handle the URL.
- Upload and download methods are optional, as some providers may only support one or the other.

### Adding a New Storage Provider

To add a new storage provider, follow these steps:

1. Create a new file in the `src/storage-providers/` directory for your provider, e.g., `src/storage-providers/my-provider.ts`.
2. Implement the `StorageProvider` interface in your new file. **Be sure to use asynchronous methods** wherever possible to avoid blocking the event loop.
3. Export your provider in `src/storage-providers/index.ts`, making sure to add it to the `storageProviders` array.
4. **Always keep the HTTPStorageProvider as the last provider in the list**, as it acts as a catch-all for any URLs not matched by other providers.

See the existing providers for examples of how to implement the interface.
