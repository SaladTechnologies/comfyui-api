/**
 * LLM provider configurations for the generate-workflow script.
 *
 * Supported providers:
 * - Anthropic (Claude): set ANTHROPIC_API_KEY
 * - MiniMax: set MINIMAX_API_KEY (uses OpenAI-compatible API)
 */

export interface LLMProviderConfig {
  name: string;
  apiUrl: string;
  model: string;
  /** Temperature value (MiniMax requires > 0.0, Anthropic accepts 0) */
  temperature: number;
  /** Returns auth headers for the provider */
  authHeaders(apiKey: string): Record<string, string>;
  /** Build the JSON request body for the given system and user prompts */
  buildRequestBody(systemPrompt: string, userPrompt: string): object;
  /** Extract the generated text from the API response */
  parseResponse(response: unknown): string;
}

export const anthropicProvider: LLMProviderConfig = {
  name: "anthropic",
  apiUrl: "https://api.anthropic.com/v1/messages",
  model: "claude-sonnet-4-20250514",
  temperature: 0,
  authHeaders(apiKey) {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  },
  buildRequestBody(systemPrompt, userPrompt) {
    return {
      model: this.model,
      system: systemPrompt,
      max_tokens: 8192,
      temperature: this.temperature,
      messages: [{ role: "user", content: userPrompt }],
    };
  },
  parseResponse(response) {
    const r = response as { content?: Array<{ text?: string }> };
    return r.content?.[0]?.text ?? "";
  },
};

export const minimaxProvider: LLMProviderConfig = {
  name: "minimax",
  apiUrl: "https://api.minimax.io/v1/chat/completions",
  model: "MiniMax-M2.7",
  // MiniMax requires temperature in (0.0, 1.0] — use a near-zero value for deterministic output
  temperature: 0.01,
  authHeaders(apiKey) {
    return { Authorization: `Bearer ${apiKey}` };
  },
  buildRequestBody(systemPrompt, userPrompt) {
    return {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 8192,
      temperature: this.temperature,
    };
  },
  parseResponse(response) {
    const r = response as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return r.choices?.[0]?.message?.content ?? "";
  },
};

/**
 * Selects an LLM provider based on available environment variables.
 * Prefers Anthropic when both keys are set.
 *
 * @param anthropicKey - value of ANTHROPIC_API_KEY (if set)
 * @param minimaxKey   - value of MINIMAX_API_KEY (if set)
 * @returns the selected provider config
 * @throws if neither key is provided
 */
export function selectProvider(
  anthropicKey?: string,
  minimaxKey?: string
): LLMProviderConfig {
  if (anthropicKey) return anthropicProvider;
  if (minimaxKey) return minimaxProvider;
  throw new Error(
    "Please set ANTHROPIC_API_KEY or MINIMAX_API_KEY environment variable"
  );
}

/**
 * Strip code-fence delimiters from a model response.
 * Models may wrap generated TypeScript in ```typescript ... ``` blocks even
 * when instructed not to; this removes those wrappers when present.
 */
export function stripCodeFences(text: string): string {
  const lines = text.split("\n");
  if (lines.length >= 2 && lines[0].startsWith("```")) {
    // Drop the opening fence and, if the last non-empty line is a fence, it too
    const inner = lines.slice(1);
    const lastNonEmpty = inner.reduceRight(
      (found, line, i) => (found === -1 && line.trim() !== "" ? i : found),
      -1
    );
    if (lastNonEmpty !== -1 && inner[lastNonEmpty].startsWith("```")) {
      inner.splice(lastNonEmpty, 1);
    }
    return inner.join("\n");
  }
  return text;
}
