import path from "path";
import { randomUUID } from "crypto";
import { FastifyBaseLogger } from "fastify";
import { ComfyNode } from "./types";
import config from "./config";
import storageManager from "./remote-storage-manager";
import { isValidUrl } from "./utils";

const configPath = path.join(config.comfyDir, "models", "configs");
const checkpointPath = path.join(config.comfyDir, "models", "checkpoints");
const diffusersPath = path.join(config.comfyDir, "models", "diffusers");
const vaePath = path.join(config.comfyDir, "models", "vae");
const loraPath = path.join(config.comfyDir, "models", "loras");

async function processCheckpointLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { config_name, ckpt_name } = node.inputs;

  if (isValidUrl(config_name)) {
    const localConfigPath = await storageManager.downloadFile(
      config_name,
      configPath,
      null,
      log
    );
    node.inputs.config_name = path.basename(localConfigPath);
  }

  if (isValidUrl(ckpt_name)) {
    const localCkptPath = await storageManager.downloadFile(
      ckpt_name,
      checkpointPath,
      null,
      log
    );
    node.inputs.ckpt_name = path.basename(localCkptPath);
  }

  return node;
}

async function processCheckpointLoaderSimpleNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { ckpt_name } = node.inputs;

  if (isValidUrl(ckpt_name)) {
    const localCkptPath = await storageManager.downloadFile(
      ckpt_name,
      checkpointPath,
      null,
      log
    );
    node.inputs.ckpt_name = path.basename(localCkptPath);
  }

  return node;
}

async function processDiffusersLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { model_path } = node.inputs;

  if (isValidUrl(model_path)) {
    const downloadedPath = await storageManager.downloadRepo(
      model_path,
      diffusersPath,
      log
    );
    node.inputs.model_path = path.basename(downloadedPath);
  }

  return node;
}

async function processLoraLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { lora_name } = node.inputs;

  if (isValidUrl(lora_name)) {
    const localLoraPath = await storageManager.downloadFile(
      lora_name,
      loraPath,
      null,
      log
    );
    node.inputs.lora_name = path.basename(localLoraPath);
  }

  return node;
}

async function processVAELoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { vae_name } = node.inputs;

  if (isValidUrl(vae_name)) {
    const localVaePath = await storageManager.downloadFile(
      vae_name,
      vaePath,
      null,
      log
    );
    node.inputs.vae_name = path.basename(localVaePath);
  }

  return node;
}

export const modelLoadingNodeTypes = new Set([
  "CheckpointLoader",
  "CheckpointLoaderSimple",
  "DiffusersLoader",
  "unCLIPCheckpointLoader",
  "LoraLoader",
  "LoraLoaderModelOnly",
  "VAELoader",
  "ControlNetLoader",
  "DiffControlNetLoader",
  "UNETLoader",
  "CLIPLoader",
  "DualCLIPLoader",
  "CLIPVisionLoader",
  "StyleModelLoader",
  "GLIGENLoader",
]);

export async function processModelLoadingNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  /**
   * ,
   */

  switch (node.class_type) {
    case "CheckpointLoader":
      return processCheckpointLoaderNode(node, log);
    case "CheckpointLoaderSimple":
    case "unCLIPCheckpointLoader":
      return processCheckpointLoaderSimpleNode(node, log);
    case "DiffusersLoader":
      return processDiffusersLoaderNode(node, log);
    case "LoraLoader":
    case "LoraLoaderModelOnly":
      return processLoraLoaderNode(node, log);
    case "VAELoader":
      return processVAELoaderNode(node, log);
    default:
      return node;
  }
}
