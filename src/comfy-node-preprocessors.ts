import path from "path";
import { FastifyBaseLogger } from "fastify";
import { ComfyNode } from "./types";
import config from "./config";
import storageManager from "./remote-storage-manager";
import { isValidUrl } from "./utils";
import { processImageOrVideo } from "./image-tools";
import { z } from "zod";

const configPath = path.join(config.comfyDir, "models", "configs");
const checkpointPath = path.join(config.comfyDir, "models", "checkpoints");
const diffusersPath = path.join(config.comfyDir, "models", "diffusers");
const vaePath = path.join(config.comfyDir, "models", "vae");
const loraPath = path.join(config.comfyDir, "models", "loras");
const controlNetPath = path.join(config.comfyDir, "models", "controlnet");
const clipPath = path.join(config.comfyDir, "models", "text_encoders");
const styleModelPath = path.join(config.comfyDir, "models", "style_models");
const gligenPath = path.join(config.comfyDir, "models", "gligen");
const upscaleModelPath = path.join(config.comfyDir, "models", "upscale_models");

export const loadImageNodes = new Set<string>([
  "LoadImage",
  "LoadImageMask",
  "LoadImageOutput",
  "VHS_LoadImagePath",
]);
export const loadDirectoryOfImagesNodes = new Set<string>([
  "VHS_LoadImages",
  "VHS_LoadImagesPath",
]);
export const loadVideoNodes = new Set<string>([
  "LoadVideo",
  "VHS_LoadVideo",
  "VHS_LoadVideoPath",
  "VHS_LoadVideoFFmpegPath",
  "VHS_LoadVideoFFmpeg",
]);

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
  "UpscaleModelLoader",
]);

function updateModelsInConfig(modelType: string, modelName: string) {
  if (config.models[modelType].all.includes(modelName)) {
    return;
  }
  config.models[modelType].all.push(modelName);
  config.models[modelType].all = Array.from(
    new Set(config.models[modelType].all)
  ).sort();
  config.models[modelType].enum = z.enum(
    config.models[modelType].all as [string, ...string[]]
  );
}

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
    const filename = path.basename(localConfigPath);
    updateModelsInConfig("configs", filename);
    node.inputs.config_name = filename;
  }

  if (isValidUrl(ckpt_name)) {
    const localCkptPath = await storageManager.downloadFile(
      ckpt_name,
      checkpointPath,
      null,
      log
    );
    const filename = path.basename(localCkptPath);
    updateModelsInConfig("checkpoints", filename);
    node.inputs.ckpt_name = filename;
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
    const filename = path.basename(localCkptPath);
    updateModelsInConfig("checkpoints", filename);
    node.inputs.ckpt_name = filename;
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
    const filename = path.basename(downloadedPath);
    updateModelsInConfig("diffusers", filename);
    node.inputs.model_path = filename;
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
    const filename = path.basename(localLoraPath);
    updateModelsInConfig("loras", filename);
    node.inputs.lora_name = filename;
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
    const filename = path.basename(localVaePath);
    updateModelsInConfig("vae", filename);
    node.inputs.vae_name = filename;
  }

  return node;
}

async function processControlNetLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { control_net_name } = node.inputs;

  if (isValidUrl(control_net_name)) {
    const localControlNetPath = await storageManager.downloadFile(
      control_net_name,
      controlNetPath,
      null,
      log
    );
    const filename = path.basename(localControlNetPath);
    updateModelsInConfig("controlnet", filename);
    node.inputs.control_net_name = filename;
  }

  return node;
}

async function processUNETLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { unet_name } = node.inputs;

  if (isValidUrl(unet_name)) {
    const localUNETPath = await storageManager.downloadFile(
      unet_name,
      diffusersPath,
      null,
      log
    );
    const filename = path.basename(localUNETPath);
    updateModelsInConfig("diffusers", filename);
    node.inputs.unet_name = filename;
  }

  return node;
}

async function processCLIPLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { clip_name } = node.inputs;

  if (isValidUrl(clip_name)) {
    const localCLIPPath = await storageManager.downloadFile(
      clip_name,
      clipPath,
      null,
      log
    );
    const filename = path.basename(localCLIPPath);
    updateModelsInConfig("text_encoders", filename);
    node.inputs.clip_name = filename;
  }

  return node;
}

async function processDualCLIPLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { clip_name1, clip_name2 } = node.inputs;
  if (isValidUrl(clip_name1)) {
    const localCLIPPath1 = await storageManager.downloadFile(
      clip_name1,
      clipPath,
      null,
      log
    );
    const filename = path.basename(localCLIPPath1);
    updateModelsInConfig("text_encoders", filename);
    node.inputs.clip_name1 = filename;
  }
  if (isValidUrl(clip_name2)) {
    const localCLIPPath2 = await storageManager.downloadFile(
      clip_name2,
      clipPath,
      null,
      log
    );
    const filename = path.basename(localCLIPPath2);
    updateModelsInConfig("text_encoders", filename);
    node.inputs.clip_name2 = filename;
  }

  return node;
}

async function processStyleModelLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { style_model_name } = node.inputs;

  if (isValidUrl(style_model_name)) {
    const localStyleModelPath = await storageManager.downloadFile(
      style_model_name,
      styleModelPath,
      null,
      log
    );
    const filename = path.basename(localStyleModelPath);
    updateModelsInConfig("style_models", filename);
    node.inputs.style_model_name = filename;
  }

  return node;
}

async function processGLIGENLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { gligen_name } = node.inputs;

  if (isValidUrl(gligen_name)) {
    const localGLIGENPath = await storageManager.downloadFile(
      gligen_name,
      gligenPath,
      null,
      log
    );
    const filename = path.basename(localGLIGENPath);
    updateModelsInConfig("gligen", filename);
    node.inputs.gligen_name = filename;
  }

  return node;
}

async function processUpscaleModelLoaderNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { model_name } = node.inputs;

  if (isValidUrl(model_name)) {
    const localModelPath = await storageManager.downloadFile(
      model_name,
      upscaleModelPath,
      null,
      log
    );
    const filename = path.basename(localModelPath);
    updateModelsInConfig("upscale_models", filename);
    node.inputs.model_name = filename;
  }

  return node;
}

export async function processModelLoadingNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
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
    case "ControlNetLoader":
    case "DiffControlNetLoader":
      return processControlNetLoaderNode(node, log);
    case "UNETLoader":
      return processUNETLoaderNode(node, log);
    case "CLIPLoader":
    case "CLIPVisionLoader":
      return processCLIPLoaderNode(node, log);
    case "DualCLIPLoader":
      return processDualCLIPLoaderNode(node, log);
    case "StyleModelLoader":
      return processStyleModelLoaderNode(node, log);
    case "GLIGENLoader":
      return processGLIGENLoaderNode(node, log);
    case "UpscaleModelLoader":
      return processUpscaleModelLoaderNode(node, log);
    default:
      return node;
  }
}

export async function processLoadImageNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  node.inputs.image = await processImageOrVideo(node.inputs.image, log);
  return node;
}

export async function processLoadDirectoryOfImagesNode(
  node: ComfyNode,
  jobId: string,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const processPromises: Promise<string>[] = [];
  for (const imageInput of node.inputs.directory) {
    processPromises.push(processImageOrVideo(imageInput, log, jobId));
  }
  await Promise.all(processPromises);
  node.inputs.directory = jobId;
  return node;
}

export async function processLoadVideoNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { video, file } = node.inputs;
  if (video) {
    node.inputs.video = await processImageOrVideo(video, log);
  }
  if (file) {
    node.inputs.file = await processImageOrVideo(file, log);
  }
  return node;
}
