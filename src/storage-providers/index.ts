import { StorageProvider } from "../types";
import { S3StorageProvider } from "./s3";
import { HTTPStorageProvider } from "./http";
import { HFStorageProvider } from "./hf";

export default [
  S3StorageProvider,
  HFStorageProvider,
  HTTPStorageProvider, // Should always be last
] as Array<new (log: any) => StorageProvider>;
