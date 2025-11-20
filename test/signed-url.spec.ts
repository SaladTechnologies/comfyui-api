import assert from "assert";
import { S3StorageProvider } from "../src/storage-providers/s3";
import { AzureBlobStorageProvider } from "../src/storage-providers/azure-blob";
import getStorageManager from "../src/remote-storage-manager";
import config from "../src/config";
import { FastifyBaseLogger } from "fastify";

// Mock logger
const mockLogger = {
    child: () => mockLogger,
    info: () => { },
    debug: () => { },
    warn: () => { },
    error: () => { },
} as unknown as FastifyBaseLogger;

describe("Signed URLs", () => {
    describe("RemoteStorageManager", () => {
        it("should return original URL if no provider supports signing", async () => {
            // Setup a mock provider that doesn't support signing
            const storageManager = getStorageManager(mockLogger);
            // We can't easily inject a mock provider into the private array without casting to any
            (storageManager as any).storageProviders = [{
                testUrl: () => true,
                // No getSignedUrl method
            }];

            const url = "https://example.com/file.png";
            const result = await storageManager.getSignedUrl(url);
            assert.strictEqual(result, url);
        });

        it("should return signed URL if provider supports it", async () => {
            const storageManager = getStorageManager(mockLogger);
            const signedUrl = "https://example.com/file.png?signature=123";
            (storageManager as any).storageProviders = [{
                testUrl: () => true,
                getSignedUrl: async () => signedUrl
            }];

            const url = "https://example.com/file.png";
            const result = await storageManager.getSignedUrl(url);
            assert.strictEqual(result, signedUrl);
        });
    });

    describe("S3StorageProvider", () => {
        // We can't easily test the actual S3 signing without mocking the S3 client, 
        // which is complex due to the AWS SDK structure. 
        // However, we can verify the method exists and throws/returns as expected with invalid inputs or mocks.

        it("should have getSignedUrl method", () => {
            // We need to mock config.awsRegion to instantiate S3StorageProvider
            const originalRegion = config.awsRegion;
            config.awsRegion = "us-east-1";

            try {
                const provider = new S3StorageProvider(mockLogger);
                assert.strictEqual(typeof provider.getSignedUrl, "function");
            } finally {
                config.awsRegion = originalRegion;
            }
        });
    });

    describe("AzureBlobStorageProvider", () => {
        it("should have getSignedUrl method", () => {
            // We need to mock config to instantiate AzureBlobStorageProvider without error
            // or just check the prototype if we can't instantiate easily.
            // But the constructor checks for config.

            const originalAccount = config.azureStorageAccount;
            const originalKey = config.azureStorageKey;

            config.azureStorageAccount = "testaccount";
            config.azureStorageKey = "testkey";

            try {
                const provider = new AzureBlobStorageProvider(mockLogger);
                assert.strictEqual(typeof provider.getSignedUrl, "function");
            } finally {
                config.azureStorageAccount = originalAccount;
                config.azureStorageKey = originalKey;
            }
        });
    });
});
