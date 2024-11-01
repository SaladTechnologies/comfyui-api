import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert";

// Looks for api key in envvar ANTHROPIC_API_KEY
assert(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY envvar not set");

const anthropic = new Anthropic();

async function generateWorkflow(input: string): Promise<any> {
  const systemPrompt = await fs.readFile(
    "claude-endpoint-creation-prompt",
    "utf-8"
  );
  const msg = await anthropic.messages.create(
    {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 8192,
      temperature: 0,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: input,
        },
      ],
    },
    {
      headers: {
        "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15",
      },
    }
  );
  let response =
    msg.content[0].type === "text" ? msg.content[0].text : JSON.stringify(msg);
  if (response.startsWith("```")) {
    const first = response.indexOf("\n");
    response = response.slice(first + 1, response.lastIndexOf("```"));
  }
  return response;
}

const usage = `Usage: node generateWorkflow.js <inputFile> <outputFile>`;
async function main() {
  // input is the contents of a file provided in the first arg
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];

  assert(inputFile, usage);
  assert(outputFile, usage);

  const inputContent = await fs.readFile(inputFile, "utf-8");
  const output = await generateWorkflow(inputContent);

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(outputFile);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputFile, output);
}

main();
