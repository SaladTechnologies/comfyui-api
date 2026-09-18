import http from "node:http";
import https from "node:https";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { prepareHttpDestination } from "./safe-http";

/** Apply the same destination policy to AWS requests, including custom endpoints. */
export class SafeS3Handler extends NodeHttpHandler {
  private active = new Set<NodeHttpHandler>();

  override async handle(...[request, options]: Parameters<NodeHttpHandler["handle"]>) {
    const hostname = request.hostname.includes(":") ? `[${request.hostname}]` : request.hostname;
    const destination = await prepareHttpDestination(`${request.protocol}//${hostname}${request.port ? `:${request.port}` : ""}`);
    const handler = new NodeHttpHandler({
      httpAgent: new http.Agent({ lookup: destination.lookup }),
      httpsAgent: new https.Agent({ lookup: destination.lookup }),
      connectionTimeout: 10_000, // Existing S3 connection timeout.
      requestTimeout: 0,
    });
    this.active.add(handler);
    const cleanup = () => { handler.destroy(); this.active.delete(handler); };
    try {
      const result = await handler.handle(request, options);
      result.response.body.once("end", cleanup);
      result.response.body.once("close", cleanup);
      result.response.body.once("error", cleanup);
      return result;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  override destroy() {
    for (const handler of this.active) handler.destroy();
    this.active.clear();
    super.destroy();
  }
}
