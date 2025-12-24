import path from "path";
import { FastifyBaseLogger } from "fastify";
import { ComfyNode, ComfyPrompt, WorkflowCredential } from "./types";
import config from "./config";
import getStorageManager from "./remote-storage-manager";
import { isValidUrl } from "./utils";
import { processInputMedia } from "./image-tools";
import { z } from "zod";
import { CredentialProvider, createCredentialProvider } from "./credential-resolver";

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
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { config_name, ckpt_name } = node.inputs;

  if (isValidUrl(config_name)) {
    const localConfigPath = await storageManager.downloadFile(
      config_name,
      configPath,
      undefined,
      getCredentials(config_name)
    );
    const filename = path.basename(localConfigPath);
    updateModelsInConfig("configs", filename);
    node.inputs.config_name = filename;
  }

  if (isValidUrl(ckpt_name)) {
    const localCkptPath = await storageManager.downloadFile(
      ckpt_name,
      checkpointPath,
      undefined,
      getCredentials(ckpt_name)
    );
    const filename = path.basename(localCkptPath);
    updateModelsInConfig("checkpoints", filename);
    node.inputs.ckpt_name = filename;
  }

  return node;
}

async function processCheckpointLoaderSimpleNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { ckpt_name } = node.inputs;

  if (isValidUrl(ckpt_name)) {
    const localCkptPath = await storageManager.downloadFile(
      ckpt_name,
      checkpointPath,
      undefined,
      getCredentials(ckpt_name)
    );
    const filename = path.basename(localCkptPath);
    updateModelsInConfig("checkpoints", filename);
    node.inputs.ckpt_name = filename;
  }

  return node;
}

async function processDiffusersLoaderNode(
  node: ComfyNode,
  _getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { model_path } = node.inputs;

  // Note: downloadRepo doesn't support credentials yet (git clone)
  if (isValidUrl(model_path)) {
    const downloadedPath = await storageManager.downloadRepo(
      model_path,
      diffusersPath
    );
    const filename = path.basename(downloadedPath);
    updateModelsInConfig("diffusers", filename);
    node.inputs.model_path = filename;
  }

  return node;
}

async function processLoraLoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { lora_name } = node.inputs;

  if (isValidUrl(lora_name)) {
    const localLoraPath = await storageManager.downloadFile(
      lora_name,
      loraPath,
      undefined,
      getCredentials(lora_name)
    );
    const filename = path.basename(localLoraPath);
    updateModelsInConfig("loras", filename);
    node.inputs.lora_name = filename;
  }

  return node;
}

async function processVAELoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { vae_name } = node.inputs;

  if (isValidUrl(vae_name)) {
    const localVaePath = await storageManager.downloadFile(
      vae_name,
      vaePath,
      undefined,
      getCredentials(vae_name)
    );
    const filename = path.basename(localVaePath);
    updateModelsInConfig("vae", filename);
    node.inputs.vae_name = filename;
  }

  return node;
}

async function processControlNetLoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { control_net_name } = node.inputs;

  if (isValidUrl(control_net_name)) {
    const localControlNetPath = await storageManager.downloadFile(
      control_net_name,
      controlNetPath,
      undefined,
      getCredentials(control_net_name)
    );
    const filename = path.basename(localControlNetPath);
    updateModelsInConfig("controlnet", filename);
    node.inputs.control_net_name = filename;
  }

  return node;
}

async function processUNETLoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { unet_name } = node.inputs;

  if (isValidUrl(unet_name)) {
    const localUNETPath = await storageManager.downloadFile(
      unet_name,
      diffusersPath,
      undefined,
      getCredentials(unet_name)
    );
    const filename = path.basename(localUNETPath);
    updateModelsInConfig("diffusers", filename);
    node.inputs.unet_name = filename;
  }

  return node;
}

async function processCLIPLoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { clip_name } = node.inputs;

  if (isValidUrl(clip_name)) {
    const localCLIPPath = await storageManager.downloadFile(
      clip_name,
      clipPath,
      undefined,
      getCredentials(clip_name)
    );
    const filename = path.basename(localCLIPPath);
    updateModelsInConfig("text_encoders", filename);
    node.inputs.clip_name = filename;
  }

  return node;
}

async function processDualCLIPLoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { clip_name1, clip_name2 } = node.inputs;
  if (isValidUrl(clip_name1)) {
    const localCLIPPath1 = await storageManager.downloadFile(
      clip_name1,
      clipPath,
      undefined,
      getCredentials(clip_name1)
    );
    const filename = path.basename(localCLIPPath1);
    updateModelsInConfig("text_encoders", filename);
    node.inputs.clip_name1 = filename;
  }
  if (isValidUrl(clip_name2)) {
    const localCLIPPath2 = await storageManager.downloadFile(
      clip_name2,
      clipPath,
      undefined,
      getCredentials(clip_name2)
    );
    const filename = path.basename(localCLIPPath2);
    updateModelsInConfig("text_encoders", filename);
    node.inputs.clip_name2 = filename;
  }

  return node;
}

async function processStyleModelLoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { style_model_name } = node.inputs;

  if (isValidUrl(style_model_name)) {
    const localStyleModelPath = await storageManager.downloadFile(
      style_model_name,
      styleModelPath,
      undefined,
      getCredentials(style_model_name)
    );
    const filename = path.basename(localStyleModelPath);
    updateModelsInConfig("style_models", filename);
    node.inputs.style_model_name = filename;
  }

  return node;
}

async function processGLIGENLoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { gligen_name } = node.inputs;

  if (isValidUrl(gligen_name)) {
    const localGLIGENPath = await storageManager.downloadFile(
      gligen_name,
      gligenPath,
      undefined,
      getCredentials(gligen_name)
    );
    const filename = path.basename(localGLIGENPath);
    updateModelsInConfig("gligen", filename);
    node.inputs.gligen_name = filename;
  }

  return node;
}

async function processUpscaleModelLoaderNode(
  node: ComfyNode,
  getCredentials: CredentialProvider
): Promise<ComfyNode> {
  const storageManager = getStorageManager();
  const { model_name } = node.inputs;

  if (isValidUrl(model_name)) {
    const localModelPath = await storageManager.downloadFile(
      model_name,
      upscaleModelPath,
      undefined,
      getCredentials(model_name)
    );
    const filename = path.basename(localModelPath);
    updateModelsInConfig("upscale_models", filename);
    node.inputs.model_name = filename;
  }

  return node;
}

export async function processModelLoadingNode(
  node: ComfyNode,
  log: FastifyBaseLogger,
  getCredentials: CredentialProvider = () => undefined
): Promise<ComfyNode> {
  switch (node.class_type) {
    case "CheckpointLoader":
      return processCheckpointLoaderNode(node, getCredentials);
    case "CheckpointLoaderSimple":
    case "unCLIPCheckpointLoader":
      return processCheckpointLoaderSimpleNode(node, getCredentials);
    case "DiffusersLoader":
      return processDiffusersLoaderNode(node, getCredentials);
    case "LoraLoader":
    case "LoraLoaderModelOnly":
      return processLoraLoaderNode(node, getCredentials);
    case "VAELoader":
      return processVAELoaderNode(node, getCredentials);
    case "ControlNetLoader":
    case "DiffControlNetLoader":
      return processControlNetLoaderNode(node, getCredentials);
    case "UNETLoader":
      return processUNETLoaderNode(node, getCredentials);
    case "CLIPLoader":
    case "CLIPVisionLoader":
      return processCLIPLoaderNode(node, getCredentials);
    case "DualCLIPLoader":
      return processDualCLIPLoaderNode(node, getCredentials);
    case "StyleModelLoader":
      return processStyleModelLoaderNode(node, getCredentials);
    case "GLIGENLoader":
      return processGLIGENLoaderNode(node, getCredentials);
    case "UpscaleModelLoader":
      return processUpscaleModelLoaderNode(node, getCredentials);
    default:
      return node;
  }
}

export async function processLoadImageNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  node.inputs.image = await processInputMedia(node.inputs.image, log);
  return node;
}

export async function processLoadDirectoryOfImagesNode(
  node: ComfyNode,
  jobId: string,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const processPromises: Promise<string>[] = [];
  for (const imageInput of node.inputs.directory) {
    processPromises.push(processInputMedia(imageInput, log, jobId));
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
    node.inputs.video = await processInputMedia(video, log);
  }
  if (file) {
    node.inputs.file = await processInputMedia(file, log);
  }
  return node;
}

export async function processLoadAudioNode(
  node: ComfyNode,
  log: FastifyBaseLogger
): Promise<ComfyNode> {
  const { audio } = node.inputs;
  if (audio) {
    node.inputs.audio = await processInputMedia(audio, log);
  }
  return node;
}

const loadDirectoryOfImagesNodeTypes = new Set<string>([
  "VHS_LoadImages",
  "VHS_LoadImagesPath",
]);
const loadVideoNodeTypes = new Set<string>([
  "LoadVideo",
  "VHS_LoadVideo",
  "VHS_LoadVideoPath",
  "VHS_LoadVideoFFmpegPath",
  "VHS_LoadVideoFFmpeg",
]);

const modelLoadingNodeTypes = new Set([
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

const audioLoadingNodeTypes = new Set(["LoadAudio"]);

export type NodeProcessError = Error & {
  code?: number;
  location?: string;
  message?: string;
};

export async function preprocessNodes(
  prompt: ComfyPrompt,
  id: string,
  log: FastifyBaseLogger,
  credentials?: WorkflowCredential[]
): Promise<{ prompt: ComfyPrompt; hasSaveImage: boolean }> {
  // Create a credential provider for URL pattern matching
  const getCredentials = createCredentialProvider(credentials);

  let hasSaveImage = false;
  for (const nodeId in prompt) {
    const node = prompt[nodeId];
    if (
      node.inputs.filename_prefix &&
      typeof node.inputs.filename_prefix === "string"
    ) {
      /**
       * If the node is for saving files, we want to set the filename_prefix
       * to the id of the prompt. This ensures no collisions between prompts
       * from different users.
       */
      node.inputs.filename_prefix = config.prependFilenames
        ? id + "_" + node.inputs.filename_prefix
        : id;
      if (
        typeof node.inputs.save_output !== "undefined" &&
        !node.inputs.save_output
      ) {
        continue;
      }
      hasSaveImage = true;
    } else if (node?.inputs?.image && typeof node.inputs.image === "string") {
      /**
       * If the node is for loading an image, the user will have provided
       * the image as base64 encoded data, or as a url. we need to download
       * the image if it's a url, and save it to a local file.
       */
      try {
        Object.assign(node, await processLoadImageNode(node, log));
      } catch (e: any) {
        const err = new Error(
          `Failed to download image for node ${nodeId}: ${e.message}`
        ) as NodeProcessError;
        err.code = 400;
        err.location = `prompt.${nodeId}.inputs.image`;
        throw err;
      }
    } else if (
      loadDirectoryOfImagesNodeTypes.has(node.class_type) &&
      Array.isArray(node.inputs.directory) &&
      node.inputs.directory.every((x: any) => typeof x === "string")
    ) {
      /**
       * If the node is for loading a directory of images, the user will have
       * provided the local directory as a string or an array of strings. If it's an
       * array, we need to download each image to a local file, and update the input
       * to be the local directory.
       */
      try {
        Object.assign(
          node,
          await processLoadDirectoryOfImagesNode(node, id, log)
        );
      } catch (e: any) {
        const err = new Error(
          `Failed to download images for node ${nodeId}: ${e.message}`
        ) as NodeProcessError;
        err.code = 400;
        err.location = `prompt.${nodeId}.inputs.directory`;
        throw err;
      }
    } else if (loadVideoNodeTypes.has(node.class_type)) {
      /**
       * If the node is for loading a video, the user will have provided
       * the video as base64 encoded data, or as a url. we need to download
       * the video if it's a url, and save it to a local file.
       */
      try {
        Object.assign(node, await processLoadVideoNode(node, log));
      } catch (e: any) {
        const err = new Error(
          `Failed to download video for node ${nodeId}: ${e.message}`
        ) as NodeProcessError;
        err.code = 400;
        err.location = `prompt.${nodeId}.inputs.video`;
        throw err;
      }
    } else if (audioLoadingNodeTypes.has(node.class_type)) {
      /**
       * If the node is for loading audio, the user will have provided
       * the audio as base64 encoded data, or as a url. we need to download
       * the audio if it's a url, and save it to a local file.
       */
      try {
        Object.assign(node, await processLoadAudioNode(node, log));
      } catch (e: any) {
        const err = new Error(
          `Failed to download audio for node ${nodeId}: ${e.message}`
        ) as NodeProcessError;
        err.code = 400;
        err.location = `prompt.${nodeId}.inputs.audio`;
        throw err;
      }
    } else if (modelLoadingNodeTypes.has(node.class_type)) {
      try {
        Object.assign(node, await processModelLoadingNode(node, log, getCredentials));
      } catch (e: any) {
        const err = new Error(
          `Failed to process model for node ${nodeId}: ${e.message}`
        ) as NodeProcessError;
        err.code = 400;
        err.location = `prompt.${nodeId}.inputs`;
        throw err;
      }
    }
  }

  return { prompt, hasSaveImage };
}
