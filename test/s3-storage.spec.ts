import fs from "fs";
import path from "path";
import os from "os";

// Setup environment and directories BEFORE importing app code
const tempDir = path.join(os.tmpdir(), "comfyui-api-test-" + Date.now());
const workflowDir = path.join(tempDir, "workflows");
const cacheDir = path.join(tempDir, "cache");
const inputDir = path.join(tempDir, "input");
const outputDir = path.join(tempDir, "output");
const modelDir = path.join(tempDir, "models");

fs.mkdirSync(workflowDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(inputDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(modelDir, { recursive: true });

process.env.WORKFLOW_DIR = workflowDir;
process.env.CACHE_DIR = cacheDir;
process.env.INPUT_DIR = inputDir;
process.env.OUTPUT_DIR = outputDir;
process.env.MODEL_DIR = modelDir;
process.env.AWS_REGION = "us-east-1";

// Now import app code
import { expect } from "earl";
import { S3StorageProvider } from "../src/storage-providers/s3";
import { FastifyBaseLogger } from "fastify";
import { S3Client } from "@aws-sdk/client-s3";
import config from "../src/config";

describe("S3StorageProvider", () => {
    let provider: S3StorageProvider;
    let mockLog: any;
    let mockS3: any;

    after(() => {
        // Cleanup
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) { }
        delete process.env.WORKFLOW_DIR;
        delete process.env.CACHE_DIR;
        delete process.env.INPUT_DIR;
        delete process.env.OUTPUT_DIR;
        delete process.env.MODEL_DIR;
        delete process.env.AWS_REGION;
        delete process.env.AWS_ENDPOINT;
        delete process.env.HTTPS_PROXY;
    });

    beforeEach(() => {
        mockLog = {
            child: () => mockLog,
            info: () => { },
            error: () => { },
            warn: () => { },
            debug: () => { },
        };

        // Reset config proxy values
        config.httpsProxy = null;
        config.httpProxy = null;
    });

    it("should log a helpful error message when upload fails with XML parsing error and no endpoint is configured", async () => {
        provider = new S3StorageProvider(mockLog as FastifyBaseLogger);
        mockS3 = {
            send: async () => { },
            config: {},
        };
        provider.s3 = mockS3 as S3Client;

        const error = new Error("char 'E' is not expected.:1:1");
        mockS3.send = async () => { throw error; };

        let errorLogArgs: any[] = [];
        mockLog.error = (...args: any[]) => {
            errorLogArgs.push(args);
        };

        const upload = provider.uploadFile("s3://bucket/key", Buffer.from("content"), "text/plain");
        await upload.upload();

        const helpfulMessage = "Error uploading file to S3. It looks like you are using a custom S3 provider but haven't configured AWS_ENDPOINT. Please set AWS_ENDPOINT or S3_ENDPOINT in your environment variables.";

        const hasHelpfulMessage = errorLogArgs.some(args => args[0] === helpfulMessage);
        expect(hasHelpfulMessage).toEqual(true);
    });

    it("should NOT log the helpful error message if endpoint IS configured", async () => {
        provider = new S3StorageProvider(mockLog as FastifyBaseLogger);
        mockS3 = {
            send: async () => { },
            config: { endpoint: "https://custom.endpoint" },
        };
        provider.s3 = mockS3 as S3Client;

        const error = new Error("char 'E' is not expected.:1:1");
        mockS3.send = async () => { throw error; };

        let errorLogArgs: any[] = [];
        mockLog.error = (...args: any[]) => {
            errorLogArgs.push(args);
        };

        const upload = provider.uploadFile("s3://bucket/key", Buffer.from("content"), "text/plain");
        await upload.upload();

        const helpfulMessage = "Error uploading file to S3. It looks like you are using a custom S3 provider but haven't configured AWS_ENDPOINT. Please set AWS_ENDPOINT or S3_ENDPOINT in your environment variables.";

        const hasHelpfulMessage = errorLogArgs.some(args => args[0] === helpfulMessage);
        expect(hasHelpfulMessage).toEqual(false);

        const hasActualError = errorLogArgs.some(args => args[0] === "Error uploading file to S3:" && args[1] === error);
        expect(hasActualError).toEqual(true);
    });

    it("should initialize successfully when HTTPS_PROXY is set", async () => {
        // Directly modify the config object since it's a singleton
        config.httpsProxy = "http://proxy.example.com:8080";

        // The test is simply to verify that the provider can be initialized without errors
        // when proxy is configured. We don't need to inspect internal implementation details.
        expect(() => {
            provider = new S3StorageProvider(mockLog as FastifyBaseLogger);
        }).not.toThrow();

        // Verify the provider was created successfully
        expect(provider).toBeTruthy();
        expect(provider.s3).toBeTruthy();
    });
});
