import { z } from "zod";
import { randomUUID } from "crypto";
import { RawData } from "ws";

export const ComfyNodeSchema = z.object({
  inputs: z.any(),
  class_type: z.string(),
  _meta: z.any().optional(),
});

export type ComfyNode = z.infer<typeof ComfyNodeSchema>;

export type ComfyPrompt = Record<string, ComfyNode>;

export const JPEGOptionsSchema = z.object({
  quality: z.number().optional().default(80).describe("quality, integer 1-100"),
  progressive: z
    .boolean()
    .optional()
    .default(false)
    .describe("use progressive (interlace) scan"),
  chromaSubsampling: z
    .string()
    .optional()
    .default("4:2:0")
    .describe(
      "set to '4:4:4' to prevent chroma subsampling otherwise defaults to '4:2:0' chroma subsampling"
    ),
  optimizeCoding: z
    .boolean()
    .optional()
    .default(true)
    .describe("optimize Huffman coding tables"),
  mozjpeg: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "use mozjpeg defaults, equivalent to { trellisQuantisation: true, overshootDeringing: true, optimizeScans: true, quantisationTable: 3 }"
    ),
  trellisQuantisation: z
    .boolean()
    .optional()
    .default(false)
    .describe("apply trellis quantisation"),
  overshootDeringing: z
    .boolean()
    .optional()
    .default(false)
    .describe("apply overshoot deringing"),
  optimizeScans: z
    .boolean()
    .optional()
    .default(false)
    .describe("optimize progressive scans"),
  quantisationTable: z
    .number()
    .optional()
    .default(0)
    .describe("set quantization table (0-8)"),
});

export type JPEGOptions = z.infer<typeof JPEGOptionsSchema>;

export const WebpOptionsSchema = z.object({
  quality: z
    .number()
    .int()
    .optional()
    .default(80)
    .describe("quality, integer 1-100"),
  alphaQuality: z
    .number()
    .int()
    .optional()
    .default(100)
    .describe("quality of alpha layer, integer 1-100"),
  lossless: z
    .boolean()
    .optional()
    .default(false)
    .describe("use lossless compression mode"),
  nearLossless: z
    .boolean()
    .optional()
    .default(false)
    .describe("use near_lossless compression mode"),
  smartSubsample: z
    .boolean()
    .optional()
    .default(false)
    .describe("use smart_subsample mode"),
  preset: z
    .enum(["default", "photo", "picture", "drawing", "icon", "text"])
    .optional()
    .default("default")
    .describe(
      "named preset for preprocessing/filtering, one of: default, photo, picture, drawing, icon, text"
    ),
  effort: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .default(4)
    .describe("CPU effort, between 0 (fastest) and 6 (slowest)"),
});

export type WebpOptions = z.infer<typeof WebpOptionsSchema>;

export const OutputConversionOptionsSchema = z.object({
  format: z.enum(["jpeg", "jpg", "webp"]).describe("output format"),
  options: z.union([JPEGOptionsSchema, WebpOptionsSchema]).optional(),
});

export type OutputConversionOptions = z.infer<
  typeof OutputConversionOptionsSchema
>;

export const ExecutionStatsSchema = z.object({
  comfy_execution: z.object({
    start: z.number(),
    end: z.number(),
    duration: z.number(),
    nodes: z.record(
      z.object({
        start: z.number(),
      })
    ),
  }),
  preprocess_time: z.number().optional(),
  comfy_round_trip_time: z.number().optional(),
  postprocess_time: z.number().optional(),
  upload_time: z.number().optional(),
  total_time: z.number().optional(),
});

export type ExecutionStats = z.infer<typeof ExecutionStatsSchema>;
export function isExecutionStats(obj: any): obj is ExecutionStats {
  return ExecutionStatsSchema.safeParse(obj).success;
}

export const PromptErrorResponseSchema = z.object({
  error: z.string(),
  location: z.string().optional(),
});

export type PromptErrorResponse = z.infer<typeof PromptErrorResponseSchema>;

export const WorkflowSchema = z.object({
  RequestSchema: z.object({}),
  generateWorkflow: z.function(),
});

export interface Workflow {
  RequestSchema: z.ZodObject<any, any>;
  generateWorkflow: (input: any) => Promise<ComfyPrompt> | ComfyPrompt;
  description?: string;
  summary?: string;
}

export function isWorkflow(obj: any): obj is Workflow {
  return (
    obj != null &&
    typeof obj === "object" &&
    "RequestSchema" in obj &&
    "generateWorkflow" in obj
  );
}

export interface WorkflowTree {
  [key: string]: WorkflowTree | Workflow;
}

export interface ComfyWSMessage {
  type:
    | "status"
    | "progress"
    | "progress_state"
    | "executing"
    | "execution_start"
    | "execution_cached"
    | "executed"
    | "execution_success"
    | "execution_interrupted"
    | "execution_error";
  data: any;
  sid: string | null;
}

export interface ComfyWSStatusMessage extends ComfyWSMessage {
  type: "status";
  data: {
    status: {
      exec_info: {
        queue_remaining: number;
      };
    };
  };
}

export interface ComfyWSProgressMessage extends ComfyWSMessage {
  type: "progress";
  data: {
    value: number;
    max: number;
    prompt_id: string;
    node: string | null;
  };
}

export interface ComfyWSProgressStateMessage extends ComfyWSMessage {
  type: "progress_state";
  data: {
    prompt_id: string;
    nodes: Record<
      string,
      {
        value: number;
        max: number;
        state: string;
        node_id: string;
        prompt_id: string;
        display_node_id?: string;
        parent_node_id?: string;
        real_node_id?: string;
      }
    >;
  };
}

export interface ComfyWSExecutingMessage extends ComfyWSMessage {
  type: "executing";
  data: {
    node: string | null;
    display_node: string;
    prompt_id: string;
  };
}

export interface ComfyWSExecutionStartMessage extends ComfyWSMessage {
  type: "execution_start";
  data: {
    prompt_id: string;
    timestamp: number;
  };
}

export interface ComfyWSExecutionCachedMessage extends ComfyWSMessage {
  type: "execution_cached";
  data: {
    nodes: string[];
    prompt_id: string;
    timestamp: number;
  };
}

export interface ComfyWSExecutedMessage extends ComfyWSMessage {
  type: "executed";
  data: {
    node: string;
    display_node: string;
    output: any;
    prompt_id: string;
  };
}

export interface ComfyWSExecutionSuccessMessage extends ComfyWSMessage {
  type: "execution_success";
  data: {
    prompt_id: string;
    timestamp: number;
  };
}

export interface ComfyWSExecutionInterruptedMessage extends ComfyWSMessage {
  type: "execution_interrupted";
  data: {
    prompt_id: string;
    node_id: string;
    node_type: string;
    executed: any[];
  };
}

export interface ComfyWSExecutionErrorMessage extends ComfyWSMessage {
  type: "execution_error";
  data: {
    prompt_id: string;
    node_id: string;
    node_type: string;
    executed: any[];
    exception_message: string;
    exception_type: string;
    traceback: string;
    current_inputs: any;
    current_outputs: any[];
  };
}

export function isStatusMessage(
  msg: ComfyWSMessage
): msg is ComfyWSStatusMessage {
  return msg.type === "status";
}

export function isProgressMessage(
  msg: ComfyWSMessage
): msg is ComfyWSProgressMessage {
  return msg.type === "progress";
}

export function isProgressStateMessage(
  msg: ComfyWSMessage
): msg is ComfyWSProgressStateMessage {
  return msg.type === "progress_state";
}

export function isExecutingMessage(
  msg: ComfyWSMessage
): msg is ComfyWSExecutingMessage {
  return msg.type === "executing";
}

export function isExecutionStartMessage(
  msg: ComfyWSMessage
): msg is ComfyWSExecutionStartMessage {
  return msg.type === "execution_start";
}

export function isExecutionCachedMessage(
  msg: ComfyWSMessage
): msg is ComfyWSExecutionCachedMessage {
  return msg.type === "execution_cached";
}

export function isExecutedMessage(
  msg: ComfyWSMessage
): msg is ComfyWSExecutedMessage {
  return msg.type === "executed";
}

export function isExecutionSuccessMessage(
  msg: ComfyWSMessage
): msg is ComfyWSExecutionSuccessMessage {
  return msg.type === "execution_success";
}

export function isExecutionInterruptedMessage(
  msg: ComfyWSMessage
): msg is ComfyWSExecutionInterruptedMessage {
  return msg.type === "execution_interrupted";
}

export function isExecutionErrorMessage(
  msg: ComfyWSMessage
): msg is ComfyWSExecutionErrorMessage {
  return msg.type === "execution_error";
}

export type WebhookHandlers = {
  onMessage?: (msg: RawData) => Promise<void> | void;
  onStatus?: (data: ComfyWSStatusMessage) => Promise<void> | void;
  onProgress?: (data: ComfyWSProgressMessage) => Promise<void> | void;
  onProgressState?: (data: ComfyWSProgressStateMessage) => Promise<void> | void;
  onExecuting?: (data: ComfyWSExecutingMessage) => Promise<void> | void;
  onExecutionStart?: (
    data: ComfyWSExecutionStartMessage
  ) => Promise<void> | void;
  onExecutionCached?: (
    data: ComfyWSExecutionCachedMessage
  ) => Promise<void> | void;
  onExecuted?: (data: ComfyWSExecutedMessage) => Promise<void> | void;
  onExecutionSuccess?: (data: ComfyWSExecutionSuccessMessage) => Promise<void>;
  onExecutionError?: (
    data: ComfyWSExecutionErrorMessage
  ) => Promise<void> | void;
  onExecutionInterrupted?: (
    data: ComfyWSExecutionInterruptedMessage
  ) => Promise<void> | void;
  onFileDownloaded?: (data: {
    url: string;
    local_path: string;
    size: number;
    duration: number;
  }) => Promise<void> | void;
  onFileUploaded?: (data: {
    url: string;
    local_path: string;
    size: number;
    duration: number;
  }) => Promise<void> | void;
  onFileDeleted?: (data: {
    url: string;
    local_path: string;
    size: number;
  }) => Promise<void> | void;
};

export const SystemWebhookEvents = [
  "message",
  "status",
  "progress",
  "progress_state",
  "executing",
  "execution_start",
  "execution_cached",
  "executed",
  "execution_success",
  "execution_interrupted",
  "execution_error",
  "file_downloaded",
  "file_uploaded",
  "file_deleted",
] as const;

export type ComfyPromptResponse = {
  prompt_id: string;
  number: number;
  node_errors: any[];
};

export type ComfyHistoryResponse = Record<
  string,
  {
    prompt: [number, string, ComfyPrompt, any, string[]];
    outputs: Record<
      string,
      Record<
        string,
        {
          filename: string;
        }[]
      >
    >;
    status: {
      status_str: string;
      completed: boolean;
      messages: any[];
    };
  }
>;

export interface Upload {
  state: "in-progress" | "completed" | "failed" | "aborted";

  upload(): Promise<void>;
  abort(): Promise<void>;
}

/**
 * Authentication configuration for download requests.
 * Supports multiple auth types for different storage providers and services.
 */
export const DownloadAuthSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bearer"),
    token: z.string().describe("Bearer token for Authorization header"),
  }),
  z.object({
    type: z.literal("basic"),
    username: z.string().describe("Username for basic auth"),
    password: z.string().describe("Password for basic auth"),
  }),
  z.object({
    type: z.literal("header"),
    header_name: z.string().describe("Custom header name"),
    header_value: z.string().describe("Custom header value"),
  }),
  z.object({
    type: z.literal("query"),
    query_param: z.string().describe("Query parameter name (e.g., 'sig' for Azure SAS)"),
    query_value: z.string().describe("Query parameter value"),
  }),
  z.object({
    type: z.literal("s3"),
    access_key_id: z.string().describe("AWS access key ID"),
    secret_access_key: z.string().describe("AWS secret access key"),
    session_token: z.string().optional().describe("AWS session token for temporary credentials (STS)"),
    endpoint: z.string().optional().describe("Custom S3 endpoint (for non-AWS S3-compatible services)"),
    region: z.string().optional().describe("AWS region (defaults to env config)"),
  }),
]);

export type DownloadAuth = z.infer<typeof DownloadAuthSchema>;

/**
 * Options for download operations, including optional authentication.
 */
export const DownloadOptionsSchema = z.object({
  auth: DownloadAuthSchema.optional(),
});

export type DownloadOptions = z.infer<typeof DownloadOptionsSchema>;

/**
 * Credential entry for per-request authentication.
 * Associates a URL pattern with authentication credentials.
 */
export const WorkflowCredentialSchema = z.object({
  url_pattern: z.string().describe("URL pattern to match (supports glob-style wildcards like https://example.com/*)"),
  auth: DownloadAuthSchema,
});

export type WorkflowCredential = z.infer<typeof WorkflowCredentialSchema>;

export const PromptRequestSchema = z.object({
  prompt: z.record(ComfyNodeSchema),
  id: z
    .string()
    .optional()
    .default(() => randomUUID()),
  webhook: z.string().optional(),
  webhook_v2: z.string().optional(),
  convert_output: OutputConversionOptionsSchema.optional(),
  credentials: z
    .array(WorkflowCredentialSchema)
    .optional()
    .describe("Per-request credentials for protected URLs, matched by URL pattern"),
});

export interface StorageProvider {
  /**
   * The key in a request body that indicates this storage provider should be used for upload.
   * Must be unique across all storage providers, and must be included if `uploadFile` is implemented.
   */
  requestBodyUploadKey?: string;

  /**
   * The zod schema for the request body field that indicates this storage provider should
   * be used for upload. Must be included if `requestBodyUploadKey` is defined.
   */
  requestBodyUploadSchema?: z.ZodObject<any, any>;

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
   * @param options Optional download options including authentication
   *
   * @resolves The path to the downloaded file
   */
  downloadFile?(
    url: string,
    outputDir: string,
    filenameOverride?: string,
    options?: DownloadOptions
  ): Promise<string>;

  /**
   * Validate authentication credentials without downloading the file.
   * Used to verify credentials on cache hits for auth-required URLs.
   * @param url URL to validate access to
   * @param options Download options containing authentication
   *
   * @resolves void if auth is valid
   * @throws Error if auth is invalid or access is denied
   */
  validateAuth?(url: string, options: DownloadOptions): Promise<void>;
}

export const DownloadRequestSchema = z.object({
  url: z.string().url(),
  model_type: z.string(),
  filename: z.string().optional(),
  wait: z.boolean().optional().default(false),
  auth: DownloadAuthSchema.optional().describe("Optional authentication for accessing protected resources"),
});

export type DownloadRequest = z.infer<typeof DownloadRequestSchema>;

export const DownloadResponseSchema = z.object({
  url: z.string(),
  model_type: z.string(),
  filename: z.string(),
  status: z.enum(["started", "completed"]),
  size: z.number().optional(),
  duration: z.number().optional(),
});

export type DownloadResponse = z.infer<typeof DownloadResponseSchema>;

export const DownloadErrorResponseSchema = z.object({
  error: z.string(),
});
