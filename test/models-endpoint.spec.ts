import assert from "node:assert";
import { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import { z } from "zod";

// Mock config before importing server
process.env.MODEL_DIR = "/tmp/comfyui-api-test-models";
process.env.COMFY_HOME = "/tmp/comfyui-api-test-home";
process.env.MAX_CONCURRENT_DOWNLOADS = "10";
process.env.MAX_CONCURRENT_UPLOADS = "10";
process.env.WORKFLOW_DIR = "/tmp/comfyui-api-test-workflows";

// Create mock directories
const modelDir = process.env.MODEL_DIR;
fs.mkdirSync(modelDir, { recursive: true });
fs.mkdirSync(path.join(modelDir, "checkpoints"), { recursive: true });
fs.mkdirSync(path.join(modelDir, "loras"), { recursive: true });

const checkpointsDir = path.join(process.env.MODEL_DIR, "checkpoints");
fs.mkdirSync(checkpointsDir, { recursive: true });

describe("POST /models", () => {
    let server: FastifyInstance;
    let originalDownloadFile: any;
    let getStorageManager: any;

    before(async () => {
        // Dynamically require getStorageManager
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const rsmModule = require("../src/remote-storage-manager");
        getStorageManager = rsmModule.default;

        // Mock RemoteStorageManager.downloadFile
        // We need to do this before importing server if possible, or modify the instance.
        // Since getStorageManager returns a singleton, we can modify it.
        const storageManager = getStorageManager({
            info: () => { },
            debug: () => { },
            warn: () => { },
            error: () => { },
            child: () => ({ info: () => { }, debug: () => { }, warn: () => { }, error: () => { } }),
        } as any);

        originalDownloadFile = storageManager.downloadFile;
        storageManager.downloadFile = async (url: string, dir: string, filename?: string) => {
            const finalFilename = filename || "test_model.safetensors";
            const filePath = path.join(dir, finalFilename);
            fs.writeFileSync(filePath, "dummy content");
            return filePath;
        };

        // Import server after setting up mocks and env vars
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("../src/server");
        server = mod.server;
        await server.ready();
    });

    after(async () => {
        // Restore original method
        if (getStorageManager) {
            const storageManager = getStorageManager({} as any);
            storageManager.downloadFile = originalDownloadFile;
        }
        if (server) {
            await server.close();
        }

        // Cleanup
        if (process.env.COMFY_HOME) {
            fs.rmSync(process.env.COMFY_HOME, { recursive: true, force: true });
        }
        if (process.env.MODEL_DIR) {
            fs.rmSync(process.env.MODEL_DIR, { recursive: true, force: true });
        }
    });

    it("should download a model successfully", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/models",
            payload: {
                url: "https://example.com/model.safetensors",
                type: "checkpoints",
                filename: "custom_model.safetensors",
            },
        });

        assert.strictEqual(response.statusCode, 200);
        const body = JSON.parse(response.payload);
        assert.strictEqual(body.status, "ok");
        assert.ok(body.path.endsWith("custom_model.safetensors"));

        // Verify file creation
        const filePath = path.join(checkpointsDir, "custom_model.safetensors");
        assert.ok(fs.existsSync(filePath));
    });

    it("should return 400 for invalid model type", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/models",
            payload: {
                url: "https://example.com/model.safetensors",
                type: "invalid_type",
            },
        });

        assert.strictEqual(response.statusCode, 400);
    });

    it("should return 400 for invalid URL", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/models",
            payload: {
                url: "not-a-url",
                type: "checkpoints",
            },
        });

        assert.strictEqual(response.statusCode, 400);
    });
});
