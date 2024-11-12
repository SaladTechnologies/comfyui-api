import { z } from "zod";
import { randomUUID } from "crypto";

export const ComfyNodeSchema = z.object({
  inputs: z.any(),
  class_type: z.string(),
  _meta: z.any().optional(),
});

export type ComfyNode = z.infer<typeof ComfyNodeSchema>;

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
  images: z.array(z.string().base64()).optional(),
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
  generateWorkflow: (input: any) => Record<string, ComfyNode>;
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
  images: z.array(z.string().base64()).optional(),
  webhook: z.string().optional(),
  convert_output: OutputConversionOptionsSchema.optional(),
  status: z.enum(["ok"]).optional(),
});
