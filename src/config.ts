import assert from "node:assert";
import fs from "node:fs";
const {
  CMD = "init.sh",
  HOST = "::",
  PORT = "3000",
  DIRECT_ADDRESS = "127.0.0.1",
  COMFYUI_PORT_HOST = "8188",
  STARTUP_CHECK_INTERVAL_S = "1",
  STARTUP_CHECK_MAX_TRIES = "10",
  OUTPUT_DIR = "/opt/ComfyUI/output",
  INPUT_DIR = "/opt/ComfyUI/input",
  WARMUP_PROMPT_FILE,
} = process.env;

const comfyURL = `http://${DIRECT_ADDRESS}:${COMFYUI_PORT_HOST}`;
const port = parseInt(PORT, 10);
const startupCheckInterval = parseInt(STARTUP_CHECK_INTERVAL_S, 10) * 1000;
const startupCheckMaxTries = parseInt(STARTUP_CHECK_MAX_TRIES, 10);

let warmupPrompt: string | undefined;
if (WARMUP_PROMPT_FILE) {
  assert(fs.existsSync(WARMUP_PROMPT_FILE), "Warmup prompt file not found");
  try {
    warmupPrompt = JSON.parse(
      fs.readFileSync(WARMUP_PROMPT_FILE, { encoding: "utf-8" })
    );
  } catch (e: any) {
    throw new Error(`Failed to parse warmup prompt: ${e.message}`);
  }
}

const config = {
  comfyLaunchCmd: CMD,
  wrapperHost: HOST,
  wrapperPort: port,
  comfyHost: DIRECT_ADDRESS,
  comfyPort: COMFYUI_PORT_HOST,
  comfyURL,
  startupCheckInterval,
  startupCheckMaxTries,
  outputDir: OUTPUT_DIR,
  inputDir: INPUT_DIR,
  warmupPrompt,
};

export default config;
