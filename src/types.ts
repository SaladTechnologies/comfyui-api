import { z } from "zod";
import { randomUUID } from "crypto";
import { RawData } from "ws";

export const ComfyNodeSchema = z.object({
  inputs: z
    .any()
    .describe("Input parameters for the node. Structure depends on the node type."),
  class_type: z.string().describe("The type of the node (e.g., 'KSampler')."),
  _meta: z.any().optional().describe("Metadata for the node (e.g., title)."),
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

export const VideoOptionsSchema = z.object({
  codec: z.string().optional().describe("video codec"),
  fps: z.number().optional().describe("frames per second"),
  crf: z.number().optional().describe("constant rate factor"),
  preset: z.string().optional().describe("encoder preset"),
  bitrate: z.string().optional().describe("video bitrate"),
});

export type VideoOptions = z.infer<typeof VideoOptionsSchema>;

export const AudioOptionsSchema = z.object({
  codec: z.string().optional().describe("audio codec"),
  bitrate: z.string().optional().describe("audio bitrate"),
  frequency: z.number().optional().describe("audio frequency"),
});

export type AudioOptions = z.infer<typeof AudioOptionsSchema>;

export const OutputConversionOptionsSchema = z.object({
  format: z
    .enum(["jpeg", "jpg", "webp", "mp4", "gif", "webm", "mp3", "wav", "ogg"])
    .describe("output format"),
  options: z
    .union([
      JPEGOptionsSchema,
      WebpOptionsSchema,
      VideoOptionsSchema,
      AudioOptionsSchema,
    ])
    .optional(),
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

export const PromptRequestSchema = z.object({
  prompt: z
    .record(ComfyNodeSchema)
    .describe(
      "The ComfyUI prompt workflow. This is a dictionary where keys are node IDs and values are node configurations."
    )
    .refine((data) => Object.keys(data).length > 0, {
      message: "Prompt cannot be empty",
    }),
  id: z
    .string()
    .optional()
    .default(() => randomUUID())
    .describe(
      "Unique ID for the prompt. If not provided, one will be generated."
    ),
  webhook: z
    .string()
    .optional()
    .describe(
      "URL to send a webhook to when the prompt execution is complete. (Legacy)"
    ),
  webhook_v2: z
    .string()
    .optional()
    .describe(
      "URL to send a webhook to when the prompt execution is complete. Supports signing."
    ),
  convert_output: OutputConversionOptionsSchema.optional().describe(
    "Options to convert the output images/video to a different format."
  ),
  compress_outputs: z
    .boolean()
    .optional()
    .describe(
      "If true, the output images will be compressed into a single archive."
    ),
  signed_url: z
    .boolean()
    .optional()
    .describe(
      "If true, the webhook will contain signed URLs for the output files instead of the files themselves."
    ),
});

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
  return "RequestSchema" in obj && "generateWorkflow" in obj;
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
  | "execution_error"
  | "logs"
  | "feature_flags"
  | "binary_preview";
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

export interface ComfyWSLogsMessage extends ComfyWSMessage {
  type: "logs";
  data: {
    entries: Array<{
      level: string;
      message: string;
      timestamp?: number;
    }>;
    terminal?: {
      rows: number;
      cols: number;
    };
  };
}

export function isLogsMessage(
  msg: ComfyWSMessage
): msg is ComfyWSLogsMessage {
  return msg.type === "logs";
}

export interface ComfyWSFeatureFlagsMessage extends ComfyWSMessage {
  type: "feature_flags";
  data: {
    flags: Record<string, boolean | string | number>;
  };
}

export function isFeatureFlagsMessage(
  msg: ComfyWSMessage
): msg is ComfyWSFeatureFlagsMessage {
  return msg.type === "feature_flags";
}

export interface ComfyWSBinaryPreviewMessage extends ComfyWSMessage {
  type: "binary_preview";
  data: {
    prompt_id: string;
    image_type: string;
    image_data: string; // Base64 encoded
  };
}

export function isBinaryPreviewMessage(
  msg: ComfyWSMessage
): msg is ComfyWSBinaryPreviewMessage {
  return msg.type === "binary_preview";
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
  onLogs?: (data: ComfyWSLogsMessage) => Promise<void> | void;
  onFeatureFlags?: (data: ComfyWSFeatureFlagsMessage) => Promise<void> | void;
  onBinaryPreview?: (data: ComfyWSBinaryPreviewMessage) => Promise<void> | void;
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
  "logs",
  "feature_flags",
  "binary_preview",
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
   *
   * @resolves The path to the downloaded file
   */
  downloadFile?(
    url: string,
    outputDir: string,
    filenameOverride?: string
  ): Promise<string>;

  /**
   * Get a signed URL for the given URL.
   * @param url URL to sign
   * @returns A promise that resolves to the signed URL
   */
  getSignedUrl?(url: string): Promise<string>;
}
