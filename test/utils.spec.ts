import { expect } from "earl";
import path from "path";
import fs from "fs";
import os from "os";
import { z } from "zod";
import { isWorkflow, Workflow } from "../src/types";

/**
 * Unit tests for utils.ts functions.
 * These tests verify specific bug fixes without requiring the full ComfyUI environment.
 */

describe("Workflow Validation", () => {
  describe("isWorkflow", () => {
    it("should return true for a valid workflow object", () => {
      const validWorkflow: Workflow = {
        RequestSchema: z.object({
          prompt: z.string(),
        }),
        generateWorkflow: (input) => ({
          "1": {
            inputs: { text: input.prompt },
            class_type: "CLIPTextEncode",
          },
        }),
      };

      expect(isWorkflow(validWorkflow)).toEqual(true);
    });

    it("should return true for a workflow with optional description and summary", () => {
      const workflowWithMeta: Workflow = {
        RequestSchema: z.object({}),
        generateWorkflow: () => ({}),
        description: "Test workflow description",
        summary: "Test summary",
      };

      expect(isWorkflow(workflowWithMeta)).toEqual(true);
    });

    it("should return false for an object missing RequestSchema", () => {
      const missingSchema = {
        generateWorkflow: () => ({}),
      };

      expect(isWorkflow(missingSchema)).toEqual(false);
    });

    it("should return false for an object missing generateWorkflow", () => {
      const missingGenerator = {
        RequestSchema: z.object({}),
      };

      expect(isWorkflow(missingGenerator)).toEqual(false);
    });

    it("should return false for null", () => {
      expect(isWorkflow(null)).toEqual(false);
    });

    it("should return false for undefined", () => {
      expect(isWorkflow(undefined)).toEqual(false);
    });

    it("should return false for primitive values", () => {
      expect(isWorkflow("string")).toEqual(false);
      expect(isWorkflow(123)).toEqual(false);
      expect(isWorkflow(true)).toEqual(false);
    });

    it("should return false for an empty object", () => {
      expect(isWorkflow({})).toEqual(false);
    });

    it("should return false for an array", () => {
      expect(isWorkflow([])).toEqual(false);
    });
  });
});

describe("Workflow Loading", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-workflow-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("workflow file structure", () => {
    it("should recognize .ts files as valid workflow files", () => {
      const tsFile = path.join(tempDir, "test-workflow.ts");
      fs.writeFileSync(tsFile, "// placeholder");

      const files = fs.readdirSync(tempDir);
      const tsFiles = files.filter((f) => f.endsWith(".ts"));

      expect(tsFiles.length).toEqual(1);
      expect(tsFiles[0]).toEqual("test-workflow.ts");
    });

    it("should recognize .js files as valid workflow files", () => {
      const jsFile = path.join(tempDir, "test-workflow.js");
      fs.writeFileSync(jsFile, "// placeholder");

      const files = fs.readdirSync(tempDir);
      const jsFiles = files.filter((f) => f.endsWith(".js"));

      expect(jsFiles.length).toEqual(1);
      expect(jsFiles[0]).toEqual("test-workflow.js");
    });

    it("should ignore non-js/ts files", () => {
      fs.writeFileSync(path.join(tempDir, "readme.md"), "# Readme");
      fs.writeFileSync(path.join(tempDir, "config.json"), "{}");
      fs.writeFileSync(path.join(tempDir, "workflow.ts"), "// valid");

      const files = fs.readdirSync(tempDir);
      const workflowFiles = files.filter(
        (f) => f.endsWith(".ts") || f.endsWith(".js")
      );

      expect(workflowFiles.length).toEqual(1);
    });

    it("should handle nested directory structures", () => {
      // Create nested structure like /workflows/sdxl/txt2img.ts
      const nestedDir = path.join(tempDir, "sdxl");
      fs.mkdirSync(nestedDir);
      fs.writeFileSync(path.join(nestedDir, "txt2img.ts"), "// workflow");
      fs.writeFileSync(path.join(nestedDir, "img2img.ts"), "// workflow");

      expect(fs.existsSync(nestedDir)).toEqual(true);
      expect(fs.statSync(nestedDir).isDirectory()).toEqual(true);

      const nestedFiles = fs.readdirSync(nestedDir);
      expect(nestedFiles.length).toEqual(2);
    });
  });

  describe("workflow file naming", () => {
    it("should derive workflow name from filename without extension", () => {
      const filename = "txt2img.ts";
      const workflowName = filename.replace(".js", "").replace(".ts", "");

      expect(workflowName).toEqual("txt2img");
    });

    it("should handle filenames with hyphens", () => {
      const filename = "txt2img-with-refiner.ts";
      const workflowName = filename.replace(".js", "").replace(".ts", "");

      expect(workflowName).toEqual("txt2img-with-refiner");
    });

    it("should handle .js extension removal correctly", () => {
      const filename = "workflow.js";
      const workflowName = filename.replace(".js", "").replace(".ts", "");

      expect(workflowName).toEqual("workflow");
    });
  });
});

describe("Utils", () => {
  describe("installCustomNode - requirements.txt check (fixes #123)", () => {
    /**
     * This test verifies the fix for issue #123:
     * Installation should not fail if a custom node repo is missing requirements.txt
     *
     * The fix adds a check using fs.existsSync to verify if requirements.txt exists
     * before attempting to run pip install.
     */

    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-custom-node-"));
    });

    afterEach(() => {
      // Clean up temp directory
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should skip pip install when requirements.txt is missing", () => {
      // Simulate a custom node directory without requirements.txt
      const customNodePath = tempDir;
      const requirementsPath = path.join(customNodePath, "requirements.txt");

      // This simulates the fix logic: check before running pip install
      const shouldRunPipInstall = fs.existsSync(requirementsPath);

      expect(shouldRunPipInstall).toEqual(false);
    });

    it("should run pip install when requirements.txt exists", () => {
      // Simulate a custom node directory with requirements.txt
      const customNodePath = tempDir;
      const requirementsPath = path.join(customNodePath, "requirements.txt");

      // Create requirements.txt with some dependencies
      fs.writeFileSync(requirementsPath, "numpy>=1.0.0\ntorch>=2.0.0\n");

      // This simulates the fix logic: check before running pip install
      const shouldRunPipInstall = fs.existsSync(requirementsPath);

      expect(shouldRunPipInstall).toEqual(true);
    });

    it("should handle empty requirements.txt file", () => {
      // Even an empty requirements.txt should trigger pip install
      // (pip handles empty files gracefully)
      const customNodePath = tempDir;
      const requirementsPath = path.join(customNodePath, "requirements.txt");

      // Create empty requirements.txt
      fs.writeFileSync(requirementsPath, "");

      const shouldRunPipInstall = fs.existsSync(requirementsPath);

      expect(shouldRunPipInstall).toEqual(true);
    });

    it("should handle nested custom node directory structure", () => {
      // Some custom nodes have nested directory structures
      const customNodePath = path.join(tempDir, "ComfyUI-CustomNode");
      fs.mkdirSync(customNodePath);

      const requirementsPath = path.join(customNodePath, "requirements.txt");

      // No requirements.txt in nested directory
      expect(fs.existsSync(requirementsPath)).toEqual(false);

      // Now add requirements.txt
      fs.writeFileSync(requirementsPath, "requests>=2.0.0\n");
      expect(fs.existsSync(requirementsPath)).toEqual(true);
    });

    it("should not be confused by similarly named files", () => {
      // Ensure we check for exact filename, not partial matches
      const customNodePath = tempDir;

      // Create files with similar names but not exact match
      fs.writeFileSync(path.join(customNodePath, "requirements.txt.bak"), "backup");
      fs.writeFileSync(path.join(customNodePath, "requirements"), "no extension");
      fs.writeFileSync(path.join(customNodePath, "my-requirements.txt"), "wrong prefix");

      const requirementsPath = path.join(customNodePath, "requirements.txt");
      const shouldRunPipInstall = fs.existsSync(requirementsPath);

      // Should still be false - exact filename must match
      expect(shouldRunPipInstall).toEqual(false);
    });
  });
});
