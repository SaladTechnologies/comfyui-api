import { expect } from "earl";
import {
  createWebhookListener,
  submitPrompt,
  waitForServerToBeReady,
} from "./test-utils";
import sd15Txt2Img from "./workflows/sd1.5-txt2img.json";

describe("System Events", () => {
  before(async () => {
    await waitForServerToBeReady();
  });

  it("works", async () => {
    const uniquePrompt = JSON.parse(JSON.stringify(sd15Txt2Img));
    uniquePrompt["3"].inputs.seed = Math.floor(Math.random() * 1000000);
    const eventsReceived: { [key: string]: number } = {};
    const webhook = await createWebhookListener(async (body) => {
      if (!eventsReceived[body.event]) {
        eventsReceived[body.event] = 0;
      }
      eventsReceived[body.event]++;
    }, "/system");

    await submitPrompt(uniquePrompt);

    expect(eventsReceived).toHaveSubset({
      "comfy.progress": uniquePrompt["3"].inputs.steps,
      "comfy.executed": 1,
      "comfy.execution_success": 1,
    });

    await webhook.close();
  });
});
