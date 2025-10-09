import { StorageProvider } from "../types";
import { S3StorageProvider } from "./s3";
import { HTTPStorageProvider } from "./http";
import { HFStorageProvider } from "./hf";
import { AzureBlobStorageProvider } from "./azure-blob";

export default [
  S3StorageProvider,
  HFStorageProvider,
  AzureBlobStorageProvider,
  HTTPStorageProvider, // Should always be last
] as Array<new (log: any) => StorageProvider>;
