# Developing ComfyUI-API

This document provides guidelines for developers who want to contribute to the ComfyUI-API project. It covers setting up the development environment, coding standards, testing procedures, and how to submit contributions.

## Setting Up the Development Environment

## Coding Standards

## Testing Procedures

## Submitting Contributions

## Custom Workflows

## Storage Providers

Storage providers are modular components that handle the downloading of models and input media, as well as the uploading of completed outputs.
The ComfyUI API server supports multiple storage backends, each with its own configuration and usage.
They all live in `src/storage-providers/` and must be exported in `src/storage-providers/index.ts`.
They are defined by the `StorageProvider` interface in `src/types.ts`:

```typescript
export interface Upload {
  state: "in-progress" | "completed" | "failed" | "aborted";

  upload(): Promise<void>;
  abort(): Promise<void>;
}

export interface StorageProvider {
  /**
   * The key in a request body that indicates this storage provider should be used for upload.
   */
  requestBodyUploadKey: string;

  /**
   * The zod schema for the request body field that indicates this storage provider should
   * be used for upload.
   */
  requestBodyUploadSchema: z.ZodObject<any, any>;

  /**
   * Takes the inputs from the request body and generates a URL for uploading.
   * @param inputs
   */
  createUrl(inputs: any): string;

  /**
   * Test if the given URL can be handled by this storage provider.
   * @param url URL to test
   */
  testUrl(url: string): boolean;

  /**
   * Upload a file to the given URL.
   * @param url URL to upload to
   * @param fileOrPath File path or buffer to upload
   * @param contentType MIME type of the file
   * 
   * @returns An Upload object that can be used to start and abort the upload.
   */
  uploadFile?(
    url: string,
    fileOrPath: string | Buffer,
    contentType: string
  ): Upload;

  /**
   * Download a file from the given URL to the specified output directory.
   * @param url URL to download from
   * @param outputDir Directory to save the downloaded file
   * @param filenameOverride Optional filename to use instead of auto-generated one
   * 
   * @returns The path to the downloaded file
   */
  downloadFile?(
    url: string,
    outputDir: string,
    filenameOverride?: string
  ): Promise<string>;
}
```

Each storage provider must implement the `StorageProvider` interface, which includes methods for creating upload URLs, testing if a URL can be handled by the provider, uploading files, and downloading files.
The server will automatically select the appropriate storage provider based on the URL provided in the request body, using the `testUrl` method of each provider to determine which one can handle the URL.

### Adding a New Storage Provider

To add a new storage provider, follow these steps:

1. Create a new file in the `src/storage-providers/` directory for your provider, e.g., `src/storage-providers/my-provider.ts`.
2. Implement the `StorageProvider` interface in your new file.
3. Export your provider in `src/storage-providers/index.ts`, making sure to add it to the `storageProviders` array.
4. Always keep the HTTPStorageProvider as the last provider in the list, as it acts as a catch-all for any URLs not matched by other providers.

See the existing providers for examples of how to implement the interface.