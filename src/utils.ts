import config from "./config";
import { FastifyBaseLogger } from "fastify";
import { CommandExecutor } from "./commands";
import fs from "fs";
import fsPromises from "fs/promises";
import { Readable } from "stream";
import path from "path";
import { randomUUID } from "crypto";
import { ZodObject, ZodRawShape, ZodTypeAny, ZodDefault } from "zod";
import sharp from "sharp";
import { ComfyPrompt, OutputConversionOptions } from "./types";

const commandExecutor = new CommandExecutor();

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function launchComfyUI() {
  const cmdAndArgs = config.comfyLaunchCmd.split(" ");
  const cmd = cmdAndArgs[0];
  const args = cmdAndArgs.slice(1);
  return commandExecutor.execute(cmd, args, {
    DIRECT_ADDRESS: config.comfyHost,
    COMFYUI_PORT_HOST: config.comfyPort,
    WEB_ENABLE_AUTH: "false",
    CF_QUICK_TUNNELS: "false",
  });
}

export function shutdownComfyUI() {
  commandExecutor.interrupt();
}

export async function pingComfyUI(): Promise<void> {
  const res = await fetch(config.comfyURL);
  if (!res.ok) {
    throw new Error(`Failed to ping Comfy UI: ${await res.text()}`);
  }
}

export async function waitForComfyUIToStart(
  log: FastifyBaseLogger
): Promise<void> {
  let retries = 0;
  while (retries < config.startupCheckMaxTries) {
    try {
      await pingComfyUI();
      log.info("Comfy UI started");
      return;
    } catch (e) {
      // Ignore
    }
    retries++;
    await sleep(config.startupCheckInterval);
  }

  throw new Error(
    `Comfy UI did not start after ${
      (config.startupCheckInterval / 1000) * config.startupCheckMaxTries
    } seconds`
  );
}

export async function warmupComfyUI(): Promise<void> {
  if (config.warmupPrompt) {
    await fetch(`http://localhost:${config.wrapperPort}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: config.warmupPrompt }),
    });
  }
}

export async function downloadImage(
  imageUrl: string,
  outputPath: string,
  log: FastifyBaseLogger
): Promise<void> {
  try {
    // Fetch the image
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`Error downloading image: ${response.statusText}`);
    }

    // Get the response as a readable stream
    const body = response.body;
    if (!body) {
      throw new Error("Response body is null");
    }

    // Create a writable stream to save the file
    const fileStream = fs.createWriteStream(outputPath);

    // Pipe the response to the file
    await new Promise((resolve, reject) => {
      Readable.fromWeb(body as any)
        .pipe(fileStream)
        .on("finish", resolve)
        .on("error", reject);
    });

    log.info(`Image downloaded and saved to ${outputPath}`);
  } catch (error) {
    log.error("Error downloading image:", error);
  }
}

export async function processImage(
  imageInput: string,
  log: FastifyBaseLogger,
  dirWithinInputDir?: string
): Promise<string> {
  let localFilePath: string;
  const ext = path.extname(imageInput).split("?")[0];
  const localFileName = `${randomUUID()}${ext}`;
  if (dirWithinInputDir) {
    localFilePath = path.join(
      config.inputDir,
      dirWithinInputDir,
      localFileName
    );
    // Create the directory if it doesn't exist
    await fsPromises.mkdir(path.dirname(localFilePath), { recursive: true });
  } else {
    localFilePath = path.join(config.inputDir, localFileName);
  }
  // If image is a url, download it
  if (imageInput.startsWith("http")) {
    await downloadImage(imageInput, localFilePath, log);
    return localFilePath;
  }
  // If image is already a local path, return it as an absolute path
  else if (
    imageInput.startsWith("/") ||
    imageInput.startsWith("./") ||
    imageInput.startsWith("../")
  ) {
    return path.resolve(imageInput);
  } else {
    // Assume it's a base64 encoded image
    try {
      const base64Data = Buffer.from(imageInput, "base64");
      const image = sharp(base64Data);
      const metadata = await image.metadata();
      if (!metadata.format) {
        throw new Error("Failed to parse image metadata");
      }
      localFilePath = `${localFilePath}.${metadata.format}`;
      log.debug(`Saving decoded image to ${localFilePath}`);
      await fsPromises.writeFile(localFilePath, base64Data);
      return localFilePath;
    } catch (e: any) {
      throw new Error(`Failed to parse base64 encoded image: ${e.message}`);
    }
  }
}

export function zodToMarkdownTable(schema: ZodObject<ZodRawShape>): string {
  const shape = schema.shape;
  let markdownTable = "| Field | Type | Description | Default |\n|-|-|-|-|\n";

  for (const [key, value] of Object.entries(shape)) {
    const fieldName = key;
    const { type: fieldType, isOptional } = getZodTypeName(value);
    const fieldDescription = getZodDescription(value);
    const defaultValue = getZodDefault(value);

    markdownTable += `| ${fieldName} | ${fieldType}${
      isOptional ? "" : ""
    } | ${fieldDescription} | ${defaultValue || "**Required**"} |\n`;
  }

  return markdownTable;
}

function getZodTypeName(zodType: ZodTypeAny): {
  type: string;
  isOptional: boolean;
} {
  let currentType = zodType;
  let isOptional = false;

  while (currentType instanceof ZodDefault) {
    currentType = currentType._def.innerType;
  }

  if (currentType._def.typeName === "ZodOptional") {
    isOptional = true;
    currentType = currentType._def.innerType;
  }

  let type: string;
  switch (currentType._def.typeName) {
    case "ZodString":
      type = "string";
      break;
    case "ZodNumber":
      type = "number";
      break;
    case "ZodBoolean":
      type = "boolean";
      break;
    case "ZodArray":
      type = `${getZodTypeName(currentType._def.type).type}[]`;
      break;
    case "ZodObject":
      type = "object";
      break;
    case "ZodEnum":
      type = `enum (${(currentType._def.values as string[])
        .map((val: string) => `\`${val}\``)
        .join(", ")})`;
      break;
    case "ZodUnion":
      type = currentType._def.options
        .map((opt: any) => getZodTypeName(opt).type)
        .join(", ");
      break;
    case "ZodLiteral":
      type = `literal (${JSON.stringify(currentType._def.value)})`;
      break;
    default:
      type = currentType._def.typeName.replace("Zod", "").toLowerCase();
  }

  return { type, isOptional };
}

function getZodDescription(zodType: ZodTypeAny): string {
  let currentType: ZodTypeAny | undefined = zodType;
  while (currentType) {
    if (currentType.description) {
      return currentType.description;
    }
    currentType = currentType._def.innerType;
  }
  return "";
}

function getZodDefault(zodType: ZodTypeAny): string {
  if (zodType instanceof ZodDefault) {
    const defaultValue = zodType._def.defaultValue();
    return JSON.stringify(defaultValue);
  }
  return "-";
}

export async function convertImageBuffer(
  imageBuffer: Buffer,
  options: OutputConversionOptions
) {
  const { format, options: conversionOptions } = options;
  let image = sharp(imageBuffer);

  if (format === "webp") {
    image = image.webp(conversionOptions);
  } else {
    image = image.jpeg(conversionOptions);
  }

  return image.toBuffer();
}

export async function queuePrompt(prompt: ComfyPrompt): Promise<string> {
  const resp = await fetch(`${config.comfyURL}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!resp.ok) {
    throw new Error(`Failed to queue prompt: ${await resp.text()}`);
  }
  const { prompt_id } = await resp.json();
  return prompt_id;
}

export async function getPromptOutputs(
  promptId: string,
  log: FastifyBaseLogger
): Promise<Record<string, Buffer> | null> {
  const resp = await fetch(`${config.comfyURL}/history/${promptId}`);
  if (!resp.ok) {
    throw new Error(`Failed to get prompt outputs: ${await resp.text()}`);
  }
  const body = await resp.json();
  const allOutputs: Record<string, Buffer> = {};
  const fileLoadPromises: Promise<void>[] = [];
  if (!body[promptId]) {
    return null;
  }
  const { status, outputs } = body[promptId];
  if (status.completed) {
    for (const nodeId in outputs) {
      const node = outputs[nodeId];
      for (const outputType in node) {
        for (let outputFile of node[outputType]) {
          const filename = outputFile.filename;
          if (!filename) {
            /**
             * Some nodes have fields in the outputs that are not actual files.
             * For example, the SaveAnimatedWebP node has a field called "animated"
             * that only container boolean values mapping to the files present in
             * .images. We can safely ignore these.
             */
            continue;
          }
          const filepath = path.join(config.outputDir, filename);
          fileLoadPromises.push(
            fsPromises
              .readFile(filepath)
              .then((data) => {
                allOutputs[filename] = data;
              })
              .catch((e: any) => {
                /**
                 * The most likely reason for this is a node that has an optonal
                 * output. If the node doesn't produce that output, the file won't
                 * exist.
                 */
                log.warn(`Failed to read file ${filepath}: ${e.message}`);
              })
          );
        }
      }
    }
  } else if (status.status_str === "error") {
    throw new Error("Prompt execution failed");
  } else {
    console.log(JSON.stringify(status, null, 2));
    throw new Error("Prompt is not completed");
  }
  await Promise.all(fileLoadPromises);
  return allOutputs;
}

export async function runPromptAndGetOutputs(
  prompt: ComfyPrompt,
  log: FastifyBaseLogger
): Promise<Record<string, Buffer>> {
  const promptId = await queuePrompt(prompt);
  log.info(`Prompt queued with ID: ${promptId}`);
  while (true) {
    const outputs = await getPromptOutputs(promptId, log);
    if (outputs) {
      return outputs;
    }
    await sleep(50);
  }
}
