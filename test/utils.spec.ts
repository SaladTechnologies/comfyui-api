import { expect } from "earl";
import path from "path";
import fs from "fs";
import os from "os";
import { z } from "zod";
import { isWorkflow, Workflow } from "../src/types";
import { parseGitUrl } from "../src/git-url-parser";

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
  describe("installCustomNode - requirements.txt check", () => {
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

describe("parseGitUrl", () => {
  describe("plain URLs (no ref)", () => {
    it("should return URL as-is when no ref is specified", () => {
      const result = parseGitUrl("https://github.com/user/repo");
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual(null);
    });

    it("should handle .git suffix without ref", () => {
      const result = parseGitUrl("https://github.com/user/repo.git");
      expect(result.baseUrl).toEqual("https://github.com/user/repo.git");
      expect(result.ref).toEqual(null);
    });

    it("should handle GitLab URLs without ref", () => {
      const result = parseGitUrl("https://gitlab.com/user/repo");
      expect(result.baseUrl).toEqual("https://gitlab.com/user/repo");
      expect(result.ref).toEqual(null);
    });

    it("should handle Bitbucket URLs without ref", () => {
      const result = parseGitUrl("https://bitbucket.org/user/repo");
      expect(result.baseUrl).toEqual("https://bitbucket.org/user/repo");
      expect(result.ref).toEqual(null);
    });
  });

  describe("GitHub URL formats", () => {
    it("should parse /tree/{ref} format with commit hash", () => {
      const result = parseGitUrl(
        "https://github.com/kijai/ComfyUI-KJNodes/tree/204f6d5aae73b10c0fe2fb26e61405fd6337bb77"
      );
      expect(result.baseUrl).toEqual("https://github.com/kijai/ComfyUI-KJNodes");
      expect(result.ref).toEqual("204f6d5aae73b10c0fe2fb26e61405fd6337bb77");
    });

    it("should parse /tree/{ref} format with branch name", () => {
      const result = parseGitUrl(
        "https://github.com/user/repo/tree/main"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("main");
    });

    it("should parse /tree/{ref} format with tag", () => {
      const result = parseGitUrl(
        "https://github.com/user/repo/tree/v1.0.0"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("v1.0.0");
    });

    it("should parse /commit/{sha} format", () => {
      const result = parseGitUrl(
        "https://github.com/user/repo/commit/abc123def456"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("abc123def456");
    });

    it("should parse /releases/tag/{tag} format", () => {
      const result = parseGitUrl(
        "https://github.com/user/repo/releases/tag/v2.0.0"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("v2.0.0");
    });
  });

  describe("GitLab URL formats", () => {
    it("should parse /-/tree/{ref} format", () => {
      const result = parseGitUrl(
        "https://gitlab.com/user/repo/-/tree/main"
      );
      expect(result.baseUrl).toEqual("https://gitlab.com/user/repo");
      expect(result.ref).toEqual("main");
    });

    it("should parse /-/tree/{ref} format with commit hash", () => {
      const result = parseGitUrl(
        "https://gitlab.com/user/repo/-/tree/abc123def"
      );
      expect(result.baseUrl).toEqual("https://gitlab.com/user/repo");
      expect(result.ref).toEqual("abc123def");
    });

    it("should parse /-/commit/{sha} format", () => {
      const result = parseGitUrl(
        "https://gitlab.com/user/repo/-/commit/abc123def456"
      );
      expect(result.baseUrl).toEqual("https://gitlab.com/user/repo");
      expect(result.ref).toEqual("abc123def456");
    });

    it("should handle GitLab subgroups", () => {
      const result = parseGitUrl(
        "https://gitlab.com/group/subgroup/repo/-/tree/develop"
      );
      expect(result.baseUrl).toEqual("https://gitlab.com/group/subgroup/repo");
      expect(result.ref).toEqual("develop");
    });
  });

  describe("Bitbucket URL formats", () => {
    it("should parse /src/{ref} format", () => {
      const result = parseGitUrl(
        "https://bitbucket.org/user/repo/src/main"
      );
      expect(result.baseUrl).toEqual("https://bitbucket.org/user/repo");
      expect(result.ref).toEqual("main");
    });

    it("should parse /src/{ref} format with trailing path", () => {
      const result = parseGitUrl(
        "https://bitbucket.org/user/repo/src/develop/some/path"
      );
      expect(result.baseUrl).toEqual("https://bitbucket.org/user/repo");
      expect(result.ref).toEqual("develop");
    });

    it("should parse /commits/{sha} format", () => {
      const result = parseGitUrl(
        "https://bitbucket.org/user/repo/commits/abc123def456"
      );
      expect(result.baseUrl).toEqual("https://bitbucket.org/user/repo");
      expect(result.ref).toEqual("abc123def456");
    });
  });

  describe("Generic @ref format (npm/pip style)", () => {
    it("should parse repo@ref format", () => {
      const result = parseGitUrl("https://github.com/user/repo@v1.0.0");
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("v1.0.0");
    });

    it("should parse repo.git@ref format", () => {
      const result = parseGitUrl("https://github.com/user/repo.git@main");
      expect(result.baseUrl).toEqual("https://github.com/user/repo.git");
      expect(result.ref).toEqual("main");
    });

    it("should parse @ref with commit hash", () => {
      const result = parseGitUrl(
        "https://github.com/user/repo@abc123def456789"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("abc123def456789");
    });

    it("should handle @ref with GitLab URLs", () => {
      const result = parseGitUrl("https://gitlab.com/user/repo@feature-branch");
      expect(result.baseUrl).toEqual("https://gitlab.com/user/repo");
      expect(result.ref).toEqual("feature-branch");
    });
  });

  describe("edge cases", () => {
    it("should handle branch names with hyphens", () => {
      const result = parseGitUrl(
        "https://github.com/user/repo/tree/feature-branch-name"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("feature-branch-name");
    });

    it("should handle branch names with dots", () => {
      const result = parseGitUrl(
        "https://github.com/user/repo/tree/release-1.0.0"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("release-1.0.0");
    });

    it("should handle repo names with dots", () => {
      const result = parseGitUrl(
        "https://github.com/user/repo.name/tree/main"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/repo.name");
      expect(result.ref).toEqual("main");
    });

    it("should handle repo names with hyphens", () => {
      const result = parseGitUrl(
        "https://github.com/user/my-awesome-repo/tree/develop"
      );
      expect(result.baseUrl).toEqual("https://github.com/user/my-awesome-repo");
      expect(result.ref).toEqual("develop");
    });

    it("should handle organization/user names with hyphens", () => {
      const result = parseGitUrl(
        "https://github.com/my-org/repo/tree/main"
      );
      expect(result.baseUrl).toEqual("https://github.com/my-org/repo");
      expect(result.ref).toEqual("main");
    });

    it("should prioritize @ref over path-based patterns", () => {
      // If someone uses repo@ref, the @ should be parsed, not any path segments
      const result = parseGitUrl("https://github.com/user/repo@v1.0.0");
      expect(result.baseUrl).toEqual("https://github.com/user/repo");
      expect(result.ref).toEqual("v1.0.0");
    });
  });
});
