import * as amqp from "amqplib";
import { Connection, Channel, ConsumeMessage } from "amqplib";
import { FastifyBaseLogger } from "fastify";
import { processPrompt, PromptRequest } from "./prompt-handler";
import config from "./config";

interface EventEnvelope {
    protocol_version: string;
    task_id: string;
    event_type: string;
    timestamp: number;
    data: any;
}

export class AmqpClient {
    private connection: any = null;
    private channel: any = null;
    private log: FastifyBaseLogger;
    private connectFn: (url: string) => Promise<any>;
    private inputQueueName: string = "";

    constructor(log: FastifyBaseLogger, connectFn: (url: string) => Promise<any> = amqp.connect as any) {
        this.log = log;
        this.connectFn = connectFn;
    }

    private determineInputQueue(): string {
        if (config.instanceDedicatedId) {
            return `q.instance.${config.instanceDedicatedId}`;
        }
        if (config.instanceWorkflowId) {
            return `q.workflow.${config.instanceWorkflowId}`;
        }
        if (config.instanceIsFree) {
            return "q.gpu.free";
        }
        // Default to VRAM-based queue (e.g., q.gpu.20g)
        // Normalize VRAM string to lowercase to match queue naming convention if needed, 
        // but config says "20G", queue is "q.gpu.20g". 
        // Let's assume config.instanceGpuVram is like "20G" or "40G".
        return `q.gpu.${config.instanceGpuVram.toLowerCase()}`;
    }

    async connect() {
        if (!config.amqpUrl) {
            this.log.warn("AMQP URL not configured, skipping AMQP connection");
            return;
        }

        try {
            this.connection = await this.connectFn(config.amqpUrl);
            this.channel = await this.connection.createChannel();

            // Assert Topic Exchange
            if (config.amqpExchangeTopic) {
                await this.channel.assertExchange(config.amqpExchangeTopic, 'topic', { durable: true });
                this.log.info(`Asserted Topic Exchange: ${config.amqpExchangeTopic}`);
            }

            // Determine and Assert Input Queue
            this.inputQueueName = this.determineInputQueue();

            const queueOptions: any = { durable: true };
            // Shared GPU queues (except free) are created with max priority 10 by the backend.
            // We must match this definition to avoid PRECONDITION_FAILED errors.
            if (this.inputQueueName.startsWith("q.gpu.") && this.inputQueueName !== "q.gpu.free") {
                queueOptions.arguments = { 'x-max-priority': 10 };
            }

            await this.channel.assertQueue(this.inputQueueName, queueOptions);

            // We do NOT assert output queues (stream/result) here because the Backend consumes them.
            // We only publish to the Exchange.

            this.log.info(`Connected to AMQP broker at ${config.amqpUrl}`);
            this.log.info(`Listening on Input Queue: ${this.inputQueueName}`);

            this.consume();
        } catch (error: any) {
            this.log.error(`Failed to connect to AMQP broker: ${error.message}`);
            // Retry logic
            setTimeout(() => this.connect(), 5000);
        }
    }

    public async publishEvent(taskId: string, eventType: string, data: any) {
        if (!this.channel || !config.amqpExchangeTopic) return;

        const envelope: EventEnvelope = {
            protocol_version: "1.0",
            task_id: taskId,
            event_type: eventType,
            timestamp: Date.now(),
            data: data
        };

        // Determine Routing Key
        // Stream events: progress, executing, status, etc.
        // Result events: execution_success, execution_error, upload_complete
        const streamEvents = new Set(['progress', 'executing', 'progress_state', 'status', 'binary_preview']);
        const isStream = streamEvents.has(eventType);

        const routingKey = isStream
            ? `event.stream.${eventType}`
            : `event.result.${eventType}`;

        try {
            this.channel.publish(
                config.amqpExchangeTopic,
                routingKey,
                Buffer.from(JSON.stringify(envelope)),
                { persistent: !isStream } // Stream events can be transient, Results must be persistent
            );
            this.log.debug(`Published event ${eventType} to ${routingKey} for task ${taskId}`);
        } catch (e: any) {
            this.log.error(`Failed to publish event ${eventType} for task ${taskId}: ${e.message}`);
        }
    }

    async consume() {
        if (!this.channel || !this.inputQueueName) return;

        this.log.info(`Waiting for messages in ${this.inputQueueName}`);
        this.channel.consume(this.inputQueueName, async (msg: ConsumeMessage | null) => {
            if (msg !== null) {
                const content = msg.content.toString();
                let requestBody: PromptRequest;

                try {
                    this.log.debug(`Received raw AMQP message: ${content}`);
                    requestBody = JSON.parse(content);

                    // Handle double serialization (if backend sent a JSON string as the payload)
                    if (typeof requestBody === 'string') {
                        this.log.debug("Detected double-serialized JSON, parsing again...");
                        requestBody = JSON.parse(requestBody);
                    }

                    // Handle stringified prompt field
                    if (requestBody && typeof requestBody.prompt === 'string') {
                        this.log.debug("Detected stringified prompt field, parsing...");
                        requestBody.prompt = JSON.parse(requestBody.prompt as unknown as string);
                    }
                } catch (e) {
                    this.log.error(`Failed to parse AMQP message content as JSON: ${content}`);
                    this.channel?.nack(msg, false, false); // Reject without requeue
                    return;
                }

                const taskId = requestBody.id || "unknown";
                this.log.info(`Received AMQP task: ${taskId}`);

                try {
                    // Define progress callback
                    const onProgress = (message: any) => {
                        // Map ComfyUI message types to our event types
                        // ComfyUI messages usually have { type, data }
                        // We use the type as event_type, or map it if needed.
                        // Common types: status, progress, executing, executed
                        const eventType = message.type || 'unknown';
                        this.log.debug(`Publishing progress event ${eventType} for task ${taskId}`);
                        this.publishEvent(taskId, eventType, message.data);
                    };

                    // Execute Prompt
                    this.log.debug(`Starting processPrompt for task ${taskId}`);
                    const result = await processPrompt(requestBody, this.log, onProgress);
                    this.log.debug(`processPrompt completed for task ${taskId}`);

                    // Publish Success Event
                    // The result from processPrompt typically contains the output images/stats
                    // We wrap this in execution_success
                    await this.publishEvent(taskId, "execution_success", result);

                    // Ack the task
                    if (this.channel) {
                        this.log.debug(`Acking task ${taskId}`);
                        this.channel.ack(msg);
                    }
                } catch (error: any) {
                    this.log.error(`Error processing task ${taskId}: ${error.message}`);

                    // Publish Error Event
                    this.log.debug(`Publishing execution_error for task ${taskId}`);
                    await this.publishEvent(taskId, "execution_error", {
                        message: error.message,
                        stack: error.stack
                    });

                    // Ack the task (it failed, but we processed it)
                    // Alternatively, we could nack(requeue) if it was a transient system error,
                    // but for application errors (bad prompt), we should ack.
                    if (this.channel) {
                        this.log.debug(`Acking failed task ${taskId}`);
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
