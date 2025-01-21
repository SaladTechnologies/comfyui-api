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
  format: z.enum(["jpeg", "webp"]).describe("output format"),
  options: z.union([JPEGOptionsSchema, WebpOptionsSchema]).optional(),
});

export type OutputConversionOptions = z.infer<
  typeof OutputConversionOptionsSchema
>;

export const PromptRequestSchema = z.object({
  prompt: z.record(ComfyNodeSchema),
  id: z
    .string()
    .optional()
    .default(() => randomUUID()),
  webhook: z.string().optional(),
  convert_output: OutputConversionOptionsSchema.optional(),
});

export type PromptRequest = z.infer<typeof PromptRequestSchema>;

export const PromptResponseSchema = z.object({
  id: z.string(),
  prompt: z.record(ComfyNodeSchema),
  images: z.array(z.string()).optional(),
  filenames: z.array(z.string()).optional(),
  webhook: z.string().optional(),
  convert_output: OutputConversionOptionsSchema.optional(),
  status: z.enum(["ok"]).optional(),
});

export type PromptResponse = z.infer<typeof PromptResponseSchema>;

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

export const WorkflowRequestSchema = z.object({
  id: z
    .string()
    .optional()
    .default(() => randomUUID()),
  input: z.record(z.any()),
  webhook: z.string().optional(),
  convert_output: OutputConversionOptionsSchema.optional(),
});

export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

export const WorkflowResponseSchema = z.object({
  id: z.string(),
  input: z.record(z.any()),
  prompt: z.record(ComfyNodeSchema),
  images: z.array(z.string()).optional(),
  filenames: z.array(z.string()).optional(),
  webhook: z.string().optional(),
  convert_output: OutputConversionOptionsSchema.optional(),
  status: z.enum(["ok"]).optional(),
});

export interface ComfyWSMessage {
  type:
    | "status"
    | "progress"
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
};

export const SystemWebhookEvents = [
  "message",
  "status",
  "progress",
  "executing",
  "execution_start",
  "execution_cached",
  "executed",
  "execution_success",
  "execution_interrupted",
  "execution_error",
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
