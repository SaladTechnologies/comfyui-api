import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "child_process";
import { z } from "zod";
import { version } from "../package.json";
import yaml from "yaml";

const {
  ALWAYS_RESTART_COMFYUI = "false",
  AWS_DEFAULT_REGION,
  AWS_REGION,
  AZURE_STORAGE_ACCOUNT,
  AZURE_STORAGE_CONNECTION_STRING,
  AZURE_STORAGE_KEY,
  AZURE_STORAGE_SAS_TOKEN,
  BASE = "",
  CACHE_DIR = `${process.env.HOME}/.cache/comfyui-api`,
  CMD = "init.sh",
  COMFY_HOME = "/opt/ComfyUI",
  COMFYUI_PORT_HOST = "8188",
  DIRECT_ADDRESS = "127.0.0.1",
  HOST = "::",
  HTTP_AUTH_HEADER_NAME,
  HTTP_AUTH_HEADER_VALUE,
  INPUT_DIR,
  LOG_LEVEL = "info",
  LRU_CACHE_SIZE_GB = "0",
  MANIFEST_JSON,
  MANIFEST,
  MARKDOWN_SCHEMA_DESCRIPTIONS = "true",
  MAX_BODY_SIZE_MB = "100",
  MAX_QUEUE_DEPTH = "0",
  MODEL_DIR,
  OUTPUT_DIR,
  PORT = "3000",
  PREPEND_FILENAMES = "true",
  PROMPT_WEBHOOK_RETRIES = "3",
  SALAD_CONTAINER_GROUP_ID,
  SALAD_MACHINE_ID,
  STARTUP_CHECK_INTERVAL_S = "1",
  STARTUP_CHECK_MAX_TRIES = "20",
  SYSTEM_WEBHOOK_EVENTS,
  SYSTEM_WEBHOOK_URL,
  WARMUP_PROMPT_FILE,
  WARMUP_PROMPT_URL,
  WEBHOOK_SECRET,
  WORKFLOW_DIR = "/workflows",
} = process.env;

fs.mkdirSync(WORKFLOW_DIR, { recursive: true });

const comfyURL = `http://${DIRECT_ADDRESS}:${COMFYUI_PORT_HOST}`;
const wsClientId = randomUUID();
const comfyWSURL = `ws://${DIRECT_ADDRESS}:${COMFYUI_PORT_HOST}/ws?clientId=${wsClientId}`;
const selfURL = `http://localhost:${PORT}`;
const port = parseInt(PORT, 10);
const promptWebhookRetries = parseInt(PROMPT_WEBHOOK_RETRIES, 10);

const startupCheckInterval = parseInt(STARTUP_CHECK_INTERVAL_S, 10) * 1000;
assert(
  startupCheckInterval > 0,
  "STARTUP_CHECK_INTERVAL_S must be a positive integer"
);

const startupCheckMaxTries = parseInt(STARTUP_CHECK_MAX_TRIES, 10);
assert(
  startupCheckMaxTries > 0,
  "STARTUP_CHECK_MAX_TRIES must be a positive integer"
);

const maxBodySize = parseInt(MAX_BODY_SIZE_MB, 10) * 1024 * 1024;
assert(maxBodySize > 0, "MAX_BODY_SIZE_MB must be a positive integer");

const maxQueueDepth = parseInt(MAX_QUEUE_DEPTH, 10);
assert(maxQueueDepth >= 0, "MAX_QUEUE_DEPTH must be a non-negative integer");

const alwaysRestartComfyUI = ALWAYS_RESTART_COMFYUI.toLowerCase() === "true";
const prependFilenames = PREPEND_FILENAMES.toLowerCase() === "true";

const lruCacheSizeBytes = parseFloat(LRU_CACHE_SIZE_GB) * 1024 * 1024 * 1024;
assert(
  lruCacheSizeBytes >= 0,
  "LRU_CACHE_SIZE_GB must be a non-negative number"
);

const systemWebhook = SYSTEM_WEBHOOK_URL ?? "";
if (systemWebhook) {
  try {
    const webhook = new URL(systemWebhook);
    assert(webhook.protocol === "http:" || webhook.protocol === "https:");
  } catch (e: any) {
    throw new Error(`Invalid system webhook: ${e.message}`);
  }
}

const allEvents = new Set([
  "status",
  "progress",
  "progress_state",
  "executing",
  "execution_start",
  "execution_cached",
  "executed",
  "execution_success",
  "execution_interrupted",
  "execution_error",
  "file_downloaded",
  "file_uploaded",
  "file_deleted",
]);
let systemWebhookEvents: string[] = [];
if (SYSTEM_WEBHOOK_EVENTS === "all") {
  systemWebhookEvents = Array.from(allEvents);
} else {
  systemWebhookEvents = SYSTEM_WEBHOOK_EVENTS?.split(",") ?? [];
  assert(
    systemWebhookEvents.every((e) => allEvents.has(e)),
    `Invalid system webhook events. Supported options: ${Array.from(
      allEvents
    ).join(", ")}`
  );
}

const loadEnvCommand: Record<string, string> = {
  "ai-dock": `source /opt/ai-dock/etc/environment.sh \
  && source /opt/ai-dock/bin/venv-set.sh comfyui \
  && source "$COMFYUI_VENV/bin/activate"`,
};

// The parent directory of model_dir
const comfyDir = COMFY_HOME;
const modelDir = MODEL_DIR ?? path.join(comfyDir, "models");

let warmupPrompt: any | undefined;
let warmupCkpt: string | undefined;
if (WARMUP_PROMPT_FILE) {
  assert(fs.existsSync(WARMUP_PROMPT_FILE), "Warmup prompt file not found");
  try {
    warmupPrompt = JSON.parse(
      fs.readFileSync(WARMUP_PROMPT_FILE, { encoding: "utf-8" })
    );
    for (const nodeId in warmupPrompt) {
      const node = warmupPrompt[nodeId];
      if (node.class_type === "CheckpointLoaderSimple") {
        warmupCkpt = node.inputs.ckpt_name;
        break;
      }
    }
  } catch (e: any) {
    throw new Error(`Failed to parse warmup prompt: ${e.message}`);
  }
}

interface ComfyDescription {
  samplers: string[];
  schedulers: string[];
  version: string;
}

function getPythonCommand(): string {
  try {
    execSync("python3 --version", { stdio: "ignore" });
    return "python3";
  } catch {
    try {
      execSync("python --version", { stdio: "ignore" });
      return "python";
    } catch {
      return "python3";
    }
  }
}

/**
 * This function uses python to import some of the ComfyUI code and get the
 * description of the samplers and schedulers.
 * @returns ComfyDescription
 */
function getComfyUIDescription(): ComfyDescription {
  const temptComfyFilePath = path.join(comfyDir, "temp_comfy_description.json");
  const pythonCode = `
import comfy.samplers
import comfyui_version
import json

comfy_description = {
    "samplers": comfy.samplers.KSampler.SAMPLERS,
    "schedulers": comfy.samplers.KSampler.SCHEDULERS,
    "version": comfyui_version.__version__
}

with open("${temptComfyFilePath}", "w") as f:
    json.dump(comfy_description, f)
`;

  const tempFilePath = path.join(comfyDir, "temp_comfy_description.py");
  const pythonCommand = getPythonCommand();
  let command = `${pythonCommand} ${tempFilePath}`;
  if (BASE in loadEnvCommand) {
    command = `${loadEnvCommand[BASE]} \
    && ${pythonCommand} ${tempFilePath}`;
  }

  try {
    // Write the Python code to a temporary file
    fs.writeFileSync(tempFilePath, pythonCode);

    // Execute the Python script synchronously
    execSync(command, {
      cwd: comfyDir,
      encoding: "utf-8",
      shell: process.env.SHELL,
      env: {
        ...process.env,
      },
    });
    const output = fs.readFileSync(temptComfyFilePath, { encoding: "utf-8" });
    return JSON.parse(output.trim()) as ComfyDescription;
  } catch (error: any) {
    console.warn(
      `Failed to get ComfyUI description: ${error.message}. Using default values.`
    );
    let ver = "unknown";
    try {
      const versionTxt = fs.readFileSync(
        path.join(comfyDir, "comfyui_version.py"),
        { encoding: "utf-8" }
      );
      const m = versionTxt.match(/__version__\s*=\s*["']([^"']+)["']/);
      if (m) ver = m[1];
    } catch {}
    return {
      samplers: ["euler", "euler_a", "heun", "dpmpp_2m"],
      schedulers: ["normal", "karras", "exponential", "sgm"],
      version: ver,
    };
  } finally {
    // Clean up the temporary file
    try {
      fs.unlinkSync(tempFilePath);
    } catch (unlinkError: any) {
      console.error(`Failed to delete temporary file: ${unlinkError.message}`);
    }
  }
}

const comfyDescription = getComfyUIDescription();

function parseManifest(manifestPath: string): any {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at path: ${manifestPath}`);
  }

  const isYAML =
    manifestPath.endsWith(".yaml") || manifestPath.endsWith(".yml");
  const isJSON = manifestPath.endsWith(".json");

  if (!isYAML && !isJSON) {
    throw new Error("Manifest file must be in JSON or YAML format.");
  }

  const fileContent = fs.readFileSync(manifestPath, "utf-8");

  if (isYAML) {
    return yaml.parse(fileContent);
  }

  return JSON.parse(fileContent);
}

const modelDownloadConfigSpec = z.object({
  url: z.string().url(),
  local_path: z.string(),
});

const manifestSpec = z.object({
  apt: z.string().array().optional(),
  pip: z.string().array().optional(),
  custom_nodes: z.string().array().optional(),
  models: z.object({
    before_start: modelDownloadConfigSpec.array().optional(),
    after_start: modelDownloadConfigSpec.array().optional(),
  }),
});

const isValidManifest = (obj: any): obj is z.infer<typeof manifestSpec> => {
  const result = manifestSpec.safeParse(obj);
  return result.success;
};

let manifest: z.infer<typeof manifestSpec> | null = null;
if (MANIFEST_JSON) {
  try {
    const parsed = JSON.parse(MANIFEST_JSON);
    if (!isValidManifest(parsed)) {
      throw new Error("Invalid manifest JSON format.");
    }
    manifest = parsed;
  } catch (e: any) {
    throw new Error(`Failed to parse MANIFEST_JSON: ${e.message}`);
  }
} else if (MANIFEST) {
  manifest = parseManifest(MANIFEST);
  if (!isValidManifest(manifest)) {
    throw new Error("Invalid manifest file format.");
  }
}

const hfCLIVersion = (() => {
  try {
    const version = execSync("hf version", { encoding: "utf-8" }).trim();
    const [_, ver] = version.split(":");
    return ver.trim();
  } catch {
    return null;
  }
})();

const comfyCLIVersion = (() => {
  try {
    const version = execSync("comfy --version", { encoding: "utf-8" }).trim();
    return version;
  } catch {
    return null;
  }
})();

const uvInstalled = (() => {
  try {
    execSync("uv --version", { encoding: "utf-8" }).trim();
    return true;
  } catch {
    return false;
  }
})();

const config = {
  /**
   * If true, the wrapper will always try to restart ComfyUI when it crashes.
   * Specified by ALWAYS_RESTART_COMFYUI env var.
   * default: false
   */
  alwaysRestartComfyUI,

  /**
   * The version of ComfyUI-API. From package.json
   */
  apiVersion: version,

  /**
   * (optional) The AWS region to use for S3 operations.
   */
  awsRegion: AWS_REGION ?? AWS_DEFAULT_REGION ?? null,

  /**
   * (optional) The Azure Storage account name to use for Azure Blob operations.
   */
  azureStorageAccount: AZURE_STORAGE_ACCOUNT ?? null,

  /**
   * (optional) The Azure Storage connection string for local development (e.g., Azurite).
   */
  azureStorageConnectionString: AZURE_STORAGE_CONNECTION_STRING ?? null,

  /**
   * (optional) The Azure Storage account key for shared key authentication.
   */
  azureStorageKey: AZURE_STORAGE_KEY ?? null,

  /**
   * (optional) The Azure Storage SAS token for SAS authentication.
   */
  azureStorageSasToken: AZURE_STORAGE_SAS_TOKEN ?? null,

  /**
   * The directory where cached files are stored, specified by CACHE_DIR env var.
   * default: {HOME}/.cache/comfyui-api
   */
  cacheDir: CACHE_DIR,

  /**
   * The version of the Comfy CLI, if installed. If not installed, null.
   */
  comfyCLIVersion,

  /**
   * ComfyUI's home directory, specified by COMFY_HOME env var.
   */
  comfyDir,

  /**
   * The address to directly access ComfyUI, specified by DIRECT_ADDRESS env var.
   */
  comfyHost: DIRECT_ADDRESS,

  /**
   * The command to launch ComfyUI, specified by CMD env var.
   * It should be a command that can be executed in a shell.
   */
  comfyLaunchCmd: CMD,

  /**
   * The port that ComfyUI is listening on the host machine,
   * specified by COMFYUI_PORT_HOST env var.
   */
  comfyPort: COMFYUI_PORT_HOST,

  /**
   * ComfyUI's HTTP URL, constructed from comfyHost and comfyPort.
   */
  comfyURL,

  /**
   * The version of ComfyUI, fetched from the ComfyUI codebase.
   */
  comfyVersion: comfyDescription.version,

  /**
   * ComfyUI's WebSocket URL, constructed from comfyHost, comfyPort, and a random client ID.
   */
  comfyWSURL,

  /**
   * The version of the HuggingFace CLI, if installed. If not installed, null.
   */
  hfCLIVersion,

  /**
   * If HTTP_AUTH_HEADER_NAME and HTTP_AUTH_HEADER_VALUE are set, this will be an object to merge with headers when making http requests.
   */
  httpAuthHeader:
    HTTP_AUTH_HEADER_NAME && HTTP_AUTH_HEADER_VALUE
      ? { [HTTP_AUTH_HEADER_NAME]: HTTP_AUTH_HEADER_VALUE }
      : {},

  /**
   * The directory where input files are stored, specified by INPUT_DIR env var.
   * default: {comfyDir}/input
   */
  inputDir: INPUT_DIR ?? path.join(comfyDir, "input"),

  /**
   * The log level for the wrapper, specified by LOG_LEVEL env var.
   */
  logLevel: LOG_LEVEL.toLowerCase(),

  /**
   * The size of the LRU cache for models and files, in bytes.
   * Specified by LRU_CACHE_SIZE_GB env var.
   * default: 0 (disabled)
   */
  lruCacheSizeBytes,

  /**
   * If a manifest file is provided, this is its parsed contents.
   */
  manifest,

  /**
   * If true, the wrapper will include markdown descriptions in the
   * generated JSON schema. Specified by MARKDOWN_SCHEMA_DESCRIPTIONS env var.
   * default: true
   */
  markdownSchemaDescriptions: MARKDOWN_SCHEMA_DESCRIPTIONS === "true",

  /**
   * The maximum size of request bodies, in bytes.
   * Specified by MAX_BODY_SIZE_MB env var.
   * default: 100MB
   */
  maxBodySize,

  /**
   * The maximum number of requests allowed in the queue.
   * Specified by MAX_QUEUE_DEPTH env var.
   * default: 0 (unlimited)
   */
  maxQueueDepth,

  modelDir,

  /**
   * The contents of the models directory
   */
  models: {} as Record<
    string,
    {
      dir: string;
      all: string[];
      enum: z.ZodEnum<[string, ...string[]]>;
    }
  >,

  /**
   * The directory where output files are stored, specified by OUTPUT_DIR env var.
   * default: {comfyDir}/output
   */
  outputDir: OUTPUT_DIR ?? path.join(comfyDir, "output"),

  /**
   * If true, unique IDs will be prepended to existing filename prefixes, as opposed to replacing them.
   * Specified by PREPEND_FILENAMES env var.
   * default: true
   */
  prependFilenames,

  /**
   * The number of times to retry a post-prompt webhook if it fails.
   * Specified by PROMPT_WEBHOOK_RETRIES env var.
   * default: 3
   */
  promptWebhookRetries,

  /**
   * (optional) The Salad container group ID, specified by SALAD_CONTAINER_GROUP_ID env var.
   * This is provided automatically in SaladCloud's environment. These values will be undefined if not running in SaladCloud.
   */
  saladMetadata: {
    organizationName: process.env.SALAD_ORGANIZATION_NAME,
    organizationId: process.env.SALAD_ORGANIZATION_ID,
    projectName: process.env.SALAD_PROJECT_NAME,
    projectId: process.env.SALAD_PROJECT_ID,
    containerGroupName: process.env.SALAD_CONTAINER_GROUP_NAME,
    containerGroupId: SALAD_CONTAINER_GROUP_ID,
    instanceId: process.env.SALAD_INSTANCE_ID,
    machineId: SALAD_MACHINE_ID,
  } as {
    organizationName?: string;
    organizationId?: string;
    projectName?: string;
    projectId?: string;
    containerGroupName?: string;
    containerGroupId?: string;
    instanceId?: string;
    machineId?: string;
  } | null,

  /**
   * The list of samplers supported by ComfyUI, fetched from the ComfyUI codebase.
   * Does not include custom nodes.
   */
  samplers: z.enum(comfyDescription.samplers as [string, ...string[]]),

  /**
   * The list of schedulers supported by ComfyUI, fetched from the ComfyUI codebase.
   * Does not include custom nodes.
   */
  schedulers: z.enum(comfyDescription.schedulers as [string, ...string[]]),

  /**
   * The URL of this wrapper, constructed from HOST and PORT env vars.
   */
  selfURL,

  /**
   * The interval between startup checks, in milliseconds.
   * Specified by STARTUP_CHECK_INTERVAL_S env var.
   * default: 1000ms
   */
  startupCheckInterval,

  /**
   * The maximum number of tries for startup checks.
   * Specified by STARTUP_CHECK_MAX_TRIES env var.
   * default: 10
   */
  startupCheckMaxTries,

  /**
   * (Optional) Any metadata to include in system webhooks. Provided by SYSTEM_META_* env vars.
   * For example, SYSTEM_META_foo=bar will include "foo": "bar" in the metadata.
   */
  systemMetaData: {} as Record<string, string>,

  /**
   * (Optional) The URL of to send webhooks of system events to.
   * Specified by SYSTEM_WEBHOOK_URL env var.
   * If not specified, no webhooks will be sent.
   */
  systemWebhook,

  /**
   * The list of system events to send webhooks for.
   * Specified by SYSTEM_WEBHOOK_EVENTS env var.
   * default: [] (no events)
   * Supported events: all, status, progress, executing, execution_start,
   * execution_cached, executed, execution_success, execution_interrupted, execution_error
   * If SYSTEM_WEBHOOK_EVENTS=all, all events will be sent.
   * Otherwise, it should be a comma-separated list of events.
   */
  systemWebhookEvents,

  /**
   * If true, uv is installed and available to use.
   */
  uvInstalled,

  /**
   * If a warmup prompt is available, this is the checkpoint from it.
   */
  warmupCkpt,

  /**
   * If a warmup prompt file is provided, this is its parsed contents.
   */
  warmupPrompt,

  /**
   * (Optional) URL to download the warmup prompt from. Specified by WARMUP_PROMPT_URL env var.
   * If both WARMUP_PROMPT_FILE and WARMUP_PROMPT_URL are set, WARMUP_PROMPT_FILE takes precedence.
   */
  warmupPromptUrl: WARMUP_PROMPT_URL,

  /**
   * (Optional) The secret used to sign webhooks. Specified by WEBHOOK_SECRET env var.
   */
  webhookSecret: WEBHOOK_SECRET,

  /**
   * The directory where custom workflows are stored, specified by WORKFLOW_DIR env var.
   * default: /workflows
   */
  workflowDir: WORKFLOW_DIR,

  /**
   * The host address that the wrapper listens on, specified by HOST env var.
   * default: ::
   */
  wrapperHost: HOST,

  /**
   * The port that the wrapper listens on, specified by PORT env var.
   * default: 8080
   */
  wrapperPort: port,

  /**
   * A unique ID for this WebSocket client connection to ComfyUI.
   * Generated randomly on each startup.
   */
  wsClientId,
};

const modelSubDirs = fs.readdirSync(modelDir);
for (const modelType of modelSubDirs) {
  const model_path = path.join(modelDir, modelType);
  if (fs.statSync(model_path).isDirectory()) {
    const all = fs
      .readdirSync(model_path)
      .filter((f) => !(f.startsWith("put_") && f.endsWith("_here")))
      .sort();
    config.models[modelType] = {
      dir: model_path,
      all,
      enum: z.enum(all as [string, ...string[]]),
    };
  }
}

for (const varName of Object.keys(process.env)) {
  if (varName.startsWith("SYSTEM_META_")) {
    const key = varName.substring("SYSTEM_META_".length);
    config.systemMetaData[key] = process.env[varName] ?? "";
  }
}

if (
  config.saladMetadata &&
  Object.entries(config.saladMetadata).every(([_, v]) => v === undefined)
) {
  config.saladMetadata = null;
}

/**
 * Set the warmup prompt from downloaded content.
 * This function is called when WARMUP_PROMPT_URL is used to download the warmup file.
 */
export function setWarmupPrompt(content: string): void {
  try {
    const parsed = JSON.parse(content);
    config.warmupPrompt = parsed;

    // Extract checkpoint from warmup prompt
    for (const nodeId in parsed) {
      const node = parsed[nodeId];
      if (node.class_type === "CheckpointLoaderSimple") {
        config.warmupCkpt = node.inputs.ckpt_name;
        break;
      }
    }
  } catch (e: any) {
    throw new Error(`Failed to parse warmup prompt: ${e.message}`);
  }
}

export default config;
