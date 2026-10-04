import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const config = vi.hoisted(() => ({ outputDir: "" }));
const fetchMock = vi.hoisted(() => vi.fn());
const websocketState = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock("../src/config", () => ({ default: config }));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: fetchMock };
});
vi.mock("ws", () => {
  class MockWebSocket {
    private onHandlers = new Map<string, Set<(...args: any[]) => void>>();
    private eventHandlers = new Map<string, Set<(...args: any[]) => void>>();

    constructor() {
      websocketState.instances.push(this);
      queueMicrotask(() => this.emit("open"));
    }

    on(event: string, handler: (...args: any[]) => void) {
      const handlers = this.onHandlers.get(event) ?? new Set();
      handlers.add(handler);
      this.onHandlers.set(event, handlers);
    }

    addEventListener(event: string, handler: (...args: any[]) => void) {
      const handlers = this.eventHandlers.get(event) ?? new Set();
      handlers.add(handler);
      this.eventHandlers.set(event, handlers);
    }

    removeEventListener(event: string, handler: (...args: any[]) => void) {
      this.eventHandlers.get(event)?.delete(handler);
    }

    emit(event: string, ...args: any[]) {
      for (const handler of this.onHandlers.get(event) ?? []) handler(...args);
    }

    emitMessage(data: string) {
      this.emit("message", data, false);
      for (const handler of this.eventHandlers.get("message") ?? []) {
        handler({ data });
      }
    }

    emitClose() {
      this.emit("close");
      for (const handler of this.eventHandlers.get("close") ?? []) handler();
    }
  }

  return { default: MockWebSocket };
});

import {
  comfyIDToApiID,
  connectToComfyUIWebsocketStream,
  getPromptOutputs,
  runPromptAndGetOutputs,
} from "../src/comfy";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let outputDir: string;

beforeEach(async () => {
  outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "comfyui-output-readiness-"));
  Object.assign(config, {
    outputDir,
    comfyURL: "http://comfy.test",
    comfyWSURL: "ws://comfy.test/ws",
    wsClientId: "test-client",
  });
  fetchMock.mockReset();
  websocketState.instances.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(outputDir, { recursive: true, force: true });
});

function completedHistory(files: string[]) {
  return {
    prompt: {
      status: { completed: true, status_str: "success" },
      outputs: {
        save: {
          images: files.map((filename) => ({ filename, subfolder: "", type: "output" })),
        },
      },
    },
  };
}

function successMessage(promptId = "prompt") {
  return JSON.stringify({
    type: "execution_success",
    data: { prompt_id: promptId, timestamp: Date.now() },
  });
}

async function connectTestWebsocket() {
  await connectToComfyUIWebsocketStream({}, log as any);
  return websocketState.instances[websocketState.instances.length - 1];
}

function listenerCount(websocket: any, event: string): number {
  return websocket.eventHandlers.get(event)?.size ?? 0;
}

describe("completed output file readiness", () => {
  it("does not return history-listed outputs while one file is still missing", async () => {
    await fs.writeFile(path.join(outputDir, "ready.txt"), "ready");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => completedHistory(["ready.txt", "late.txt"]),
    });

    const outputs = await getPromptOutputs("prompt", log);

    expect(outputs).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns every output after a later history poll sees a transient file", async () => {
    await fs.writeFile(path.join(outputDir, "ready.txt"), "ready");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => completedHistory(["ready.txt", "late.txt"]),
    });

    expect(await getPromptOutputs("prompt", log)).toBeNull();
    await fs.writeFile(path.join(outputDir, "late.txt"), "late");

    await expect(getPromptOutputs("prompt", log)).resolves.toEqual({
      "ready.txt": Buffer.from("ready"),
      "late.txt": Buffer.from("late"),
    });
  });

  it("does not return a partial output set when a non-ENOENT read fails", async () => {
    await fs.writeFile(path.join(outputDir, "ready.txt"), "ready");
    await fs.writeFile(path.join(outputDir, "forbidden.txt"), "forbidden");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => completedHistory(["ready.txt", "forbidden.txt"]),
    });
    const originalReadFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, ...args) => {
      if (file.toString().endsWith("forbidden.txt")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return originalReadFile(file, ...(args as [any]));
    });

    await expect(getPromptOutputs("prompt", log)).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("retries the complete output set after websocket completion", async () => {
    await fs.writeFile(path.join(outputDir, "ready.txt"), "ready");
    let historyRequests = 0;
    let observeMissingRead!: () => void;
    let releaseMissingRead!: () => void;
    const missingReadObserved = new Promise<void>((resolve) => {
      observeMissingRead = resolve;
    });
    const missingReadGate = new Promise<void>((resolve) => {
      releaseMissingRead = resolve;
    });
    const originalReadFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, ...args) => {
      if (file.toString().endsWith("late.txt") && !(await fs.stat(file).catch(() => null))) {
        observeMissingRead();
        await missingReadGate;
        throw Object.assign(new Error("not ready"), { code: "ENOENT" });
      }
      return originalReadFile(file, ...(args as [any]));
    });
    fetchMock.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        return { ok: true, json: async () => ({ prompt_id: "prompt" }) };
      }
      historyRequests++;
      return {
        ok: true,
        json: async () => completedHistory(["ready.txt", "late.txt"]),
      };
    });
    const websocket = await connectTestWebsocket();
    const run = runPromptAndGetOutputs("api-id", {} as any, log as any);
    await missingReadObserved;
    websocket.emitMessage(successMessage());
    await fs.writeFile(path.join(outputDir, "late.txt"), "late");
    releaseMissingRead();

    await expect(run).resolves.toMatchObject({
      outputs: {
        "ready.txt": Buffer.from("ready"),
        "late.txt": Buffer.from("late"),
      },
    });
    expect(historyRequests).toBeGreaterThan(1);
    expect(comfyIDToApiID.prompt).toBe("api-id");
    expect(listenerCount(websocket, "message")).toBe(0);
    expect(listenerCount(websocket, "close")).toBe(0);
  });

  it("bounds a completed history response with a permanently missing output", async () => {
    await fs.writeFile(path.join(outputDir, "ready.txt"), "ready");
    let historyRequests = 0;
    fetchMock.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        return { ok: true, json: async () => ({ prompt_id: "prompt" }) };
      }
      historyRequests++;
      return {
        ok: true,
        json: async () => completedHistory(["ready.txt", "never.txt"]),
      };
    });
    const websocket = await connectTestWebsocket();
    const run = runPromptAndGetOutputs("api-id", {} as any, log as any);

    await expect(run).rejects.toThrow("Failed to get prompt outputs");
    const requestsAtFailure = historyRequests;
    expect(requestsAtFailure).toBeGreaterThan(90);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(historyRequests).toBe(requestsAtFailure);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(comfyIDToApiID.prompt).toBeUndefined();
    expect(listenerCount(websocket, "message")).toBe(0);
    expect(listenerCount(websocket, "close")).toBe(0);
  }, 5000);

  it("cleans up prompt state when a post-websocket output read fails", async () => {
    let releaseHistory!: () => void;
    let observeHistoryStart!: () => void;
    const historyStarted = new Promise<void>((resolve) => {
      observeHistoryStart = resolve;
    });
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    fetchMock.mockImplementation(async (_url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        return { ok: true, json: async () => ({ prompt_id: "prompt" }) };
      }
      return {
        ok: true,
        json: async () => {
          observeHistoryStart();
          await historyGate;
          return completedHistory(["forbidden.txt"]);
        },
      };
    });
    vi.spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    const websocket = await connectTestWebsocket();
    const run = runPromptAndGetOutputs("error-api-id", {} as any, log as any);
    await historyStarted;
    websocket.emitMessage(successMessage());
    releaseHistory();

    await expect(run).rejects.toMatchObject({ code: "EACCES" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(comfyIDToApiID.prompt).toBeUndefined();
    expect(listenerCount(websocket, "message")).toBe(0);
    expect(listenerCount(websocket, "close")).toBe(0);
  });
});
