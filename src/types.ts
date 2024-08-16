import { string, z } from "zod";
import { randomUUID } from "crypto";
import config from "./config";

export const ComfyNodeSchema = z.object({
  inputs: z.any(),
  class_type: z.string(),
  _meta: z.any().optional(),
});

export type ComfyNode = z.infer<typeof ComfyNodeSchema>;

export const PromptRequestSchema = z.object({
  prompt: z.record(ComfyNodeSchema),
  id: z
    .string()
    .optional()
    .default(() => randomUUID()),
  webhook: z.string().optional(),
});

export type PromptRequest = z.infer<typeof PromptRequestSchema>;

export const PromptResponseSchema = z.object({
  id: z.string(),
  prompt: z.record(ComfyNodeSchema),
  images: z.array(z.string().base64()).optional(),
  webhook: z.string().optional(),
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
}

export const WorkflowRequestSchema = z.object({
  id: z
    .string()
    .optional()
    .default(() => randomUUID()),
  input: z.record(z.any()),
  webhook: z.string().optional(),
});

export type WorkflowRequest = z.infer<typeof WorkflowRequestSchema>;

export const WorkflowResponseSchema = z.object({
  id: z.string(),
  prompt: z.record(z.any()),
  images: z.array(z.string().base64()).optional(),
  webhook: z.string().optional(),
  status: z.enum(["ok"]).optional(),
});

export const AvailableCheckpoints = z.enum(
  config.checkpoints as unknown as readonly [string, ...string[]]
);
