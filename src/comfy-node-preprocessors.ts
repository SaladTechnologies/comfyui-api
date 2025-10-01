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

export async function processCheckpointLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { config_name, ckpt_name } = node.inputs;

  if (isValidUrl(config_name)) {
    const configExtension = path.extname(config_name).split("?")[0];
    const localConfigPath = path.join(
      configPath,
      `${randomUUID()}${configExtension}`
    );
    await storageManager.downloadFile(config_name, localConfigPath, log);
    node.inputs.config_name = path.basename(localConfigPath);
  }

  if (isValidUrl(ckpt_name)) {
    const ckptExtension = path.extname(ckpt_name).split("?")[0];
    const localCkptPath = path.join(
      checkpointPath,
      `${randomUUID()}${ckptExtension}`
    );
    await storageManager.downloadFile(ckpt_name, localCkptPath, log);
    node.inputs.ckpt_name = path.basename(localCkptPath);
  }

  return node;
}

export async function processCheckpointLoaderSimpleNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { ckpt_name } = node.inputs;

  if (isValidUrl(ckpt_name)) {
    const ckptExtension = path.extname(ckpt_name).split("?")[0];
    const localCkptPath = path.join(
      checkpointPath,
      `${randomUUID()}${ckptExtension}`
    );
    await storageManager.downloadFile(ckpt_name, localCkptPath, log);
    node.inputs.ckpt_name = path.basename(localCkptPath);
  }

  return node;
}

export async function processDiffusersLoaderNode(
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

export async function processUnCLIPCheckpointLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { ckpt_name } = node.inputs;

  if (isValidUrl(ckpt_name)) {
    const ckptExtension = path.extname(ckpt_name).split("?")[0];
    const localCkptPath = path.join(
      checkpointPath,
      `${randomUUID()}${ckptExtension}`
    );
    await storageManager.downloadFile(ckpt_name, localCkptPath, log);
    node.inputs.ckpt_name = path.basename(localCkptPath);
  }

  return node;
}

export async function processModelLoadingNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  /**
   * "CheckpointLoader",
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
   */

  switch (node.class_type) {
    case "CheckpointLoader":
      return processCheckpointLoaderNode(node, log);
    case "CheckpointLoaderSimple":
      return processCheckpointLoaderSimpleNode(node, log);
    case "DiffusersLoader":
      return processDiffusersLoaderNode(node, log);
    case "unCLIPCheckpointLoader":
      return processUnCLIPCheckpointLoaderNode(node, log);
    default:
      return node;
  }
}
