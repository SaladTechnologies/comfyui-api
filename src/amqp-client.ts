import * as amqp from "amqplib";
import { Connection, Channel, ConsumeMessage } from "amqplib";
import { FastifyBaseLogger } from "fastify";
import { processPrompt, PromptRequest } from "./prompt-handler";
import config from "./config";

export class AmqpClient {
    private connection: any = null;
    private channel: any = null;
    private log: FastifyBaseLogger;
    private connectFn: (url: string) => Promise<any>;

    constructor(log: FastifyBaseLogger, connectFn: (url: string) => Promise<any> = amqp.connect as any) {
        this.log = log;
        this.connectFn = connectFn;
    }

    async connect() {
        if (!config.amqpUrl) {
            this.log.warn("AMQP URL not configured, skipping AMQP connection");
            return;
        }

        try {
            this.connection = await this.connectFn(config.amqpUrl);
            this.channel = await this.connection.createChannel();

            await this.channel.assertQueue(config.amqpQueueInput, { durable: true });
            await this.channel.assertQueue(config.amqpQueueOutput, { durable: true });

            this.log.info(`Connected to AMQP broker at ${config.amqpUrl}`);

            this.consume();
        } catch (error: any) {
            this.log.error(`Failed to connect to AMQP broker: ${error.message}`);
            // Retry logic could be added here
            setTimeout(() => this.connect(), 5000);
        }
    }

    async consume() {
        if (!this.channel) return;

        this.log.info(`Waiting for messages in ${config.amqpQueueInput}`);
        this.channel.consume(config.amqpQueueInput, async (msg: ConsumeMessage | null) => {
            if (msg !== null) {
                const content = msg.content.toString();
                let requestBody: PromptRequest;

                try {
                    requestBody = JSON.parse(content);
                } catch (e) {
                    this.log.error("Failed to parse AMQP message content as JSON");
                    this.channel?.nack(msg, false, false); // Reject without requeue
                    return;
                }

                this.log.info(`Received AMQP message: ${requestBody.id || "unknown id"}`);

                try {
                    const result = await processPrompt(requestBody, this.log);

                    const response = {
                        ...requestBody,
                        ...result,
                        status: "success"
                    };

                    if (this.channel) {
                        this.channel.sendToQueue(
                            config.amqpQueueOutput,
                            Buffer.from(JSON.stringify(response)),
                            { persistent: true, correlationId: msg.properties.correlationId }
                        );
                        this.channel.ack(msg);
                    }
                } catch (error: any) {
                    this.log.error(`Error processing AMQP message: ${error.message}`);

                    const errorResponse = {
                        ...requestBody,
                        status: "error",
                        error: error.message
                    };

                    if (this.channel) {
                        this.channel.sendToQueue(
                            config.amqpQueueOutput,
                            Buffer.from(JSON.stringify(errorResponse)),
                            { persistent: true, correlationId: msg.properties.correlationId }
                        );
                        this.channel.ack(msg);
                    }
                }
            }
        });
    }

    async close() {
        if (this.channel) await this.channel.close();
        if (this.connection) await this.connection.close();
    }
}
