import { expect, describe, it } from "vitest";
import {
  anthropicProvider,
  minimaxProvider,
  selectProvider,
  stripCodeFences,
} from "../src/llm-providers";

describe("LLM Providers - Anthropic", () => {
  it("should have the correct API URL", () => {
    expect(anthropicProvider.apiUrl).toEqual(
      "https://api.anthropic.com/v1/messages"
    );
  });

  it("should return x-api-key and anthropic-version auth headers", () => {
    const headers = anthropicProvider.authHeaders("sk-test");
    expect(headers["x-api-key"]).toEqual("sk-test");
    expect(headers["anthropic-version"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("should build a request body with system as top-level field", () => {
    const body = anthropicProvider.buildRequestBody(
      "system instructions",
      "user message"
    ) as any;
    expect(body.system).toEqual("system instructions");
    expect(body.messages).toEqual([{ role: "user", content: "user message" }]);
    expect(body.temperature).toEqual(0);
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("should parse content[0].text from Anthropic response format", () => {
    const mockResponse = {
      content: [{ type: "text", text: "import { z } from 'zod';" }],
    };
    expect(anthropicProvider.parseResponse(mockResponse)).toEqual(
      "import { z } from 'zod';"
    );
  });

  it("should return empty string when response has no content", () => {
    expect(anthropicProvider.parseResponse({})).toEqual("");
    expect(anthropicProvider.parseResponse({ content: [] })).toEqual("");
  });
});

describe("LLM Providers - MiniMax", () => {
  it("should use the OpenAI-compatible endpoint", () => {
    expect(minimaxProvider.apiUrl).toEqual(
      "https://api.minimax.io/v1/chat/completions"
    );
  });

  it("should use MiniMax-M2.7 model", () => {
    expect(minimaxProvider.model).toEqual("MiniMax-M2.7");
  });

  it("should return Bearer auth header", () => {
    const headers = minimaxProvider.authHeaders("mm-key-abc");
    expect(headers["Authorization"]).toEqual("Bearer mm-key-abc");
    expect(Object.keys(headers)).not.toContain("x-api-key");
    expect(Object.keys(headers)).not.toContain("anthropic-version");
  });

  it("should have temperature > 0 (MiniMax requires temperature in (0.0, 1.0])", () => {
    expect(minimaxProvider.temperature).toBeGreaterThan(0);
    expect(minimaxProvider.temperature).toBeLessThanOrEqual(1);
  });

  it("should build a request body with system as first message in messages array", () => {
    const body = minimaxProvider.buildRequestBody(
      "system instructions",
      "user message"
    ) as any;
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "system instructions",
    });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "user message",
    });
    expect(body.system).toBeUndefined();
  });

  it("should parse choices[0].message.content from OpenAI-compatible response format", () => {
    const mockResponse = {
      choices: [
        {
          message: { role: "assistant", content: "import { z } from 'zod';" },
          finish_reason: "stop",
        },
      ],
    };
    expect(minimaxProvider.parseResponse(mockResponse)).toEqual(
      "import { z } from 'zod';"
    );
  });

  it("should return empty string when response has no choices", () => {
    expect(minimaxProvider.parseResponse({})).toEqual("");
    expect(minimaxProvider.parseResponse({ choices: [] })).toEqual("");
  });
});

describe("selectProvider", () => {
  it("should return anthropicProvider when ANTHROPIC_API_KEY is set", () => {
    const provider = selectProvider("sk-ant-key", undefined);
    expect(provider.name).toEqual("anthropic");
  });

  it("should return minimaxProvider when only MINIMAX_API_KEY is set", () => {
    const provider = selectProvider(undefined, "mm-key");
    expect(provider.name).toEqual("minimax");
  });

  it("should prefer anthropic when both keys are set", () => {
    const provider = selectProvider("sk-ant-key", "mm-key");
    expect(provider.name).toEqual("anthropic");
  });

  it("should throw when neither key is set", () => {
    expect(() => selectProvider(undefined, undefined)).toThrow(
      /ANTHROPIC_API_KEY|MINIMAX_API_KEY/
    );
  });

  it("should throw when both keys are empty strings", () => {
    expect(() => selectProvider("", "")).toThrow();
  });
});

describe("stripCodeFences", () => {
  it("should remove ```typescript fences", () => {
    const input = "```typescript\nimport foo from 'foo';\n```";
    const result = stripCodeFences(input);
    expect(result).toEqual("import foo from 'foo';");
  });

  it("should remove plain ``` fences", () => {
    const input = "```\nconst x = 1;\n```";
    const result = stripCodeFences(input);
    expect(result).toEqual("const x = 1;");
  });

  it("should return text unchanged when there are no code fences", () => {
    const input = "import { z } from 'zod';\nconst x = z.string();";
    expect(stripCodeFences(input)).toEqual(input);
  });

  it("should preserve multi-line code", () => {
    const input =
      "```typescript\nline1\nline2\nline3\n```";
    const result = stripCodeFences(input);
    expect(result).toEqual("line1\nline2\nline3");
  });

  it("should handle text with only an opening fence gracefully", () => {
    const input = "```typescript\nconst x = 1;";
    const result = stripCodeFences(input);
    // Opening fence stripped but no closing fence found — inner content preserved
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("```typescript");
  });
});
