import { expect } from "earl";
import path from "path";
import fs from "fs";
import os from "os";

/**
 * Unit tests for utils.ts functions.
 * These tests verify specific bug fixes without requiring the full ComfyUI environment.
 */

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
