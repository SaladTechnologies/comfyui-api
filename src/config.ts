import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "child_process";
import { z } from "zod";
import { version } from "../package.json";

const {
  ALWAYS_RESTART_COMFYUI = "false",
  BASE = "ai-dock",
  CMD = "init.sh",
  COMFY_HOME = "/opt/ComfyUI",
  COMFYUI_PORT_HOST = "8188",
  DIRECT_ADDRESS = "127.0.0.1",
  HOST = "::",
  INPUT_DIR,
  LOG_LEVEL = "info",
  MARKDOWN_SCHEMA_DESCRIPTIONS = "true",
  MAX_BODY_SIZE_MB = "100",
  MAX_QUEUE_DEPTH = "0",
  MODEL_DIR,
  OUTPUT_DIR,
  PORT = "3000",
  PROMPT_WEBHOOK_RETRIES = "3",
  SALAD_MACHINE_ID,
  SALAD_CONTAINER_GROUP_ID,
  STARTUP_CHECK_INTERVAL_S = "1",
  STARTUP_CHECK_MAX_TRIES = "10",
  SYSTEM_WEBHOOK_URL,
  SYSTEM_WEBHOOK_EVENTS,
  WARMUP_PROMPT_FILE,
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
  "executing",
  "execution_start",
  "execution_cached",
  "executed",
  "execution_success",
  "execution_interrupted",
  "execution_error",
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
  let command = `python ${tempFilePath}`;
  if (BASE in loadEnvCommand) {
    command = `${loadEnvCommand[BASE]} \
    && python ${tempFilePath}`;
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
    throw new Error(`Failed to get ComfyUI description: ${error.message}`);
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

const config = {
  alwaysRestartComfyUI,
  apiVersion: version,
  comfyDir,
  comfyHost: DIRECT_ADDRESS,
  comfyLaunchCmd: CMD,
  comfyPort: COMFYUI_PORT_HOST,
  comfyURL,
  comfyVersion: comfyDescription.version,
  comfyWSURL,
  inputDir: INPUT_DIR ?? path.join(comfyDir, "input"),
  logLevel: LOG_LEVEL.toLowerCase(),
  markdownSchemaDescriptions: MARKDOWN_SCHEMA_DESCRIPTIONS === "true",
  maxBodySize,
  maxQueueDepth,
  models: {} as Record<
    string,
    {
      dir: string;
      all: string[];
      enum: z.ZodEnum<[string, ...string[]]>;
    }
  >,
  outputDir: OUTPUT_DIR ?? path.join(comfyDir, "output"),
  promptWebhookRetries,
  saladContainerGroupId: SALAD_CONTAINER_GROUP_ID,
  saladMachineId: SALAD_MACHINE_ID,
  samplers: z.enum(comfyDescription.samplers as [string, ...string[]]),
  schedulers: z.enum(comfyDescription.schedulers as [string, ...string[]]),
  selfURL,
  startupCheckInterval,
  startupCheckMaxTries,
  systemMetaData: {} as Record<string, string>,
  systemWebhook,
  systemWebhookEvents,
  warmupCkpt,
  warmupPrompt,
  workflowDir: WORKFLOW_DIR,
  wrapperHost: HOST,
  wrapperPort: port,
  wsClientId,
};

const modelDir = MODEL_DIR ?? path.join(comfyDir, "models");
const modelSubDirs = fs.readdirSync(modelDir);
for (const modelType of modelSubDirs) {
  const model_path = path.join(modelDir, modelType);
  if (fs.statSync(model_path).isDirectory()) {
    const all = fs
      .readdirSync(model_path)
      .filter((f) => !(f.startsWith("put_") && f.endsWith("_here")));
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

export default config;
