import assert from "node:assert";
import { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import { ComfyWSMessage } from "../src/types";

// Mock config
process.env.MODEL_DIR = "/tmp/comfyui-api-test-models-streaming";
process.env.COMFY_HOME = "/tmp/comfyui-api-test-home-streaming";
process.env.OUTPUT_DIR = "/tmp/comfyui-api-test-outputs-streaming";
process.env.WORKFLOW_DIR = "/tmp/comfyui-api-test-workflows-streaming";

// Create mock directories
fs.mkdirSync(process.env.MODEL_DIR, { recursive: true });
fs.mkdirSync(process.env.OUTPUT_DIR, { recursive: true });
fs.mkdirSync(process.env.WORKFLOW_DIR, { recursive: true });

describe("POST /prompt (Streaming)", function () {
    this.timeout(10000);
    let server: FastifyInstance;
    let originalRunPrompt: any;
    let comfyModule: any;

    before(async () => {
        // Mock src/comfy.ts
        // We need to intercept the require call for ./comfy

        // First, we need to make sure we can modify the module cache or use a proxy
        // Since we are using ts-node/register in mocha, we can try to require the module and modify it

        // However, prompt-handler imports it. 
        // Let's try to mock it by modifying the require cache if possible, or just assume we can overwrite the export if it was an object.
        // But it exports functions.

        // A better way might be to use a library like `proxyquire` or just rely on the fact that we can maybe mock `processPrompt` if we mock `prompt-handler`.

        // Let's try to mock `processPrompt` in `prompt-handler`? 
        // No, `server.ts` imports `processPrompt`.

        // Let's try to mock `runPromptAndGetOutputs` in `comfy.ts`.
        // We can try to use `require` to get the module and then overwrite the function property?
        // In CommonJS, exports are properties of the exports object.

        comfyModule = require("../src/comfy");
        originalRunPrompt = comfyModule.runPromptAndGetOutputs;

        comfyModule.runPromptAndGetOutputs = async (
            id: string,
            prompt: any,
            log: any,
            onProgress?: (message: ComfyWSMessage) => void
        ) => {
            // Simulate progress
            if (onProgress) {
                onProgress({
                    type: "status",
                    data: { status: { exec_info: { queue_remaining: 1 } } }
                } as any);

                onProgress({
                    type: "executing",
                    data: { node: "1", prompt_id: "test-prompt-id" }
                } as any);

                onProgress({
                    type: "progress",
                    data: { value: 50, max: 100 }
                } as any);
            }

            const outputDir = process.env.OUTPUT_DIR || "/tmp/comfyui-api-test-outputs-streaming";
            const filename = "test_output.png";
            const filePath = path.join(outputDir, filename);
            fs.writeFileSync(filePath, "fake image data");

            return {
                outputs: {
                    [filename]: Buffer.from("fake image data")
                },
                stats: {
                    comfy_execution: {
                        start: Date.now(),
                        end: Date.now() + 100,
                        duration: 100,
                        nodes: {}
                    }
                }
            };
        };

        // Import server
        const mod = require("../src/server");
        server = mod.server;
        await server.ready();
    });

    after(async () => {
        // Restore original method
        if (comfyModule) {
            comfyModule.runPromptAndGetOutputs = originalRunPrompt;
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
        if (process.env.OUTPUT_DIR) {
            fs.rmSync(process.env.OUTPUT_DIR, { recursive: true, force: true });
        }
    });

    it("should stream events when Accept header is text/event-stream", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/prompt",
            headers: {
                "Accept": "text/event-stream",
                "Content-Type": "application/json"
            },
            payload: {
                prompt: {
                    "3": {
                        inputs: {
                            seed: 1,
                            steps: 20,
                            cfg: 8,
                            sampler_name: "euler",
                            scheduler: "normal",
                            denoise: 1,
                            model: ["4", 0],
                            positive: ["6", 0],
                            negative: ["7", 0],
                            latent_image: ["5", 0]
                        },
                        class_type: "KSampler"
                    },
                    "9": {
                        inputs: {
                            filename_prefix: "ComfyUI"
                        },
                        class_type: "SaveImage"
                    }
                }
            }
        });

        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(response.headers["content-type"], "text/event-stream");

        const body = response.payload;
        const lines = body.split("\n\n").filter(Boolean);

        // Check for events
        const events = lines.map(line => {
            const [eventLine, dataLine] = line.split("\n");
            return {
                event: eventLine.replace("event: ", ""),
                data: JSON.parse(dataLine.replace("data: ", ""))
            };
        });

        assert.ok(events.length >= 3, `Expected at least 3 events, got ${events.length}`);
        assert.strictEqual(events[0].event, "message");
        assert.strictEqual(events[0].data.type, "status");

        assert.strictEqual(events[1].event, "message");
        assert.strictEqual(events[1].data.type, "executing");

        assert.strictEqual(events[2].event, "message");
        assert.strictEqual(events[2].data.type, "progress");

        const completeEvent = events.find(e => e.event === "complete");
        assert.ok(completeEvent, "Complete event not found");
        assert.ok(completeEvent.data.images, "Images not found in complete event");
    });

    it("should return normal JSON when Accept header is not text/event-stream", async () => {
        const response = await server.inject({
            method: "POST",
            url: "/prompt",
            headers: {
                "Content-Type": "application/json"
            },
            payload: {
                prompt: {
                    "3": {
                        inputs: {
                            seed: 1,
                            steps: 20,
                            cfg: 8,
                            sampler_name: "euler",
                            scheduler: "normal",
                            denoise: 1,
                            model: ["4", 0],
                            positive: ["6", 0],
                            negative: ["7", 0],
                            latent_image: ["5", 0]
                        },
                        class_type: "KSampler"
                    },
                    "9": {
                        inputs: {
                            filename_prefix: "ComfyUI"
                        },
                        class_type: "SaveImage"
                    }
                }
            }
        });

        assert.strictEqual(response.statusCode, 200);
        assert.strictEqual(response.headers["content-type"], "application/json; charset=utf-8");

        const body = JSON.parse(response.payload);
        assert.ok(body.images);
    });
});
