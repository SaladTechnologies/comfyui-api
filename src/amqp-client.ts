import * as amqp from "amqplib";
import { Connection, Channel, ConsumeMessage } from "amqplib";
import { FastifyBaseLogger } from "fastify";
import { processPrompt, PromptRequest } from "./prompt-handler";
import { camelCaseToSnakeCase } from "./utils";
import config from "./config";

interface EventEnvelope {
    protocol_version: string;
    task_id: string;
    event_type: string;
    timestamp: number;
    data: any;
    metadata?: Record<string, string>;
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

    /**
     * 发布通用消息到 Exchange（服务注册/心跳/注销等）
     */
    public async publishToExchange(routingKey: string, message: any): Promise<void> {
        if (!this.channel || !config.amqpExchangeTopic) return;
        try {
            const persistent = routingKey.includes('register') || routingKey.includes('unregister');
            this.channel.publish(
                config.amqpExchangeTopic,
                routingKey,
                Buffer.from(JSON.stringify(message)),
                { persistent }
            );
            this.log.debug(`Published to exchange: ${routingKey}`);
        } catch (e: any) {
            this.log.error(`Failed to publish to exchange: ${e.message}`);
        }
    }

    public async publishEvent(taskId: string, eventType: string, data: any, metadata?: Record<string, string>) {
        if (!this.channel || !config.amqpExchangeTopic) return;

        const envelope: EventEnvelope = {
            protocol_version: "1.0",
            task_id: taskId,
            event_type: eventType,
            timestamp: Date.now(),
            data: data
        };

        // Add metadata if provided
        if (metadata && Object.keys(metadata).length > 0) {
            envelope.metadata = metadata;
        }

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

    /**
     * Start consuming messages from the input queue
     * 
     * Processing Strategy:
     * - Sequential processing: One message at a time, fully completed before next
     * - Prefetch limit: Only fetch 1 message from queue at a time
     * - This ensures messages stay in queue until consumer is ready
     * - Enables load balancing across multiple comfyui-api instances
     * 
     * Message Flow:
     * 1. Fetch one message from RabbitMQ
     * 2. Parse and validate message
     * 3. Execute prompt (blocking, 30-60 seconds)
     * 4. Upload to S3
     * 5. Send execution_success event
     * 6. Ack message (remove from queue)
     * 7. Fetch next message (repeat)
     */
    async consume() {
        if (!this.channel || !this.inputQueueName) {
            this.log.warn("Cannot consume: channel or queue not initialized");
            return;
        }

        /**
         * Set prefetch to 1 (Quality of Service)
         * 
         * Why prefetch=1?
         * - Without prefetch limit (default=0), RabbitMQ pushes ALL messages to consumer
         * - With prefetch=1, only 1 message is delivered at a time
         * - Next message only delivered after current one is acked
         * 
         * Benefits:
         * 1. Load Balancing: Other instances can process queued messages
         * 2. Fair Distribution: Messages distributed evenly across instances
         * 3. Memory Efficient: Only 1 message in memory at a time
         * 4. Fault Tolerance: If instance crashes, unacked message returns to queue
         * 
         * Example with 3 messages and 2 instances:
         * - Without prefetch: Instance1 gets all 3, Instance2 gets 0
         * - With prefetch=1: Instance1 gets 1, Instance2 gets 1, remaining 1 in queue
         */
        await this.channel.prefetch(1);
        this.log.info(`Set prefetch=1 for fair message distribution`);

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
                    /**
                     * Process the prompt (blocking operation)
                     * 
                     * This is a synchronous operation that:
                     * 1. Calls ComfyUI to execute the workflow (30-60 seconds)
                     * 2. Waits for completion
                     * 3. Uploads results to S3
                     * 4. Returns complete results
                     * 
                     * During this time:
                     * - No other messages are processed by this instance
                     * - Other instances can process messages from the queue
                     * - WebSocket events are sent via system event handlers
                     */

                    // No onProgress callback - all events handled by system event handlers
                    // This prevents duplicate event sending

                    // Execute Prompt
                    this.log.debug(`Starting processPrompt for task ${taskId}`);
                    const result = await processPrompt(requestBody, this.log);
                    this.log.debug(`processPrompt completed for task ${taskId}`);

                    /**
                     * Send execution_success event with complete results
                     * 
                     * This is the final event containing:
                     * - S3 URLs of generated images/audio
                     * - Filenames
                     * - Execution statistics
                     * - Metadata (host, instance info)
                     */
                    const metadata: Record<string, string> = { ...config.systemMetaData };
                    if (config.saladMetadata) {
                        for (const [key, value] of Object.entries(config.saladMetadata)) {
                            if (value) {
                                metadata[`salad_${camelCaseToSnakeCase(key)}`] = value;
                            }
                        }
                    }

                    await this.publishEvent(taskId, "execution_success", result, metadata);

                    /**
                     * Acknowledge the message
                     * 
                     * This tells RabbitMQ:
                     * - Message was successfully processed
                     * - Remove it from the queue
                     * - Deliver the next message (if prefetch allows)
                     */
                    if (this.channel) {
                        this.log.debug(`Acking task ${taskId}`);
                        this.channel.ack(msg);
                    }
                } catch (error: any) {
                    this.log.error(`Error processing task ${taskId}: ${error.message}`);

                    // Publish Error Event with metadata
                    const metadata: Record<string, string> = { ...config.systemMetaData };
                    if (config.saladMetadata) {
                        for (const [key, value] of Object.entries(config.saladMetadata)) {
                            if (value) {
                                metadata[`salad_${camelCaseToSnakeCase(key)}`] = value;
                            }
                        }
                    }

                    /**
                     * Send execution_error with complete error information
                     * 
                     * Backend expects:
                     * - id: Task ID (required for handlePromptFailed)
                     * - type: Error type
                     * - message: Error message
                     * - details: Detailed error information (if available)
                     * - node_errors: Node-specific errors (if available from ComfyUI)
                     */
                    const errorData: any = {
                        id: taskId,  // Required by backend
                        type: error.name || 'execution_error',
                        message: error.message,
                        stack: error.stack
                    };

                    // If error contains ComfyUI validation errors, include them
                    if (error.message && error.message.includes('Failed to queue prompt:')) {
                        try {
                            // Extract JSON error details from message
                            const jsonMatch = error.message.match(/\{.*\}/s);
                            if (jsonMatch) {
                                const errorDetails = JSON.parse(jsonMatch[0]);
                                errorData.details = errorDetails.error;
                                errorData.node_errors = errorDetails.node_errors;
                            }
                        } catch (e) {
                            // If parsing fails, just use the original message
                            this.log.debug('Could not parse error details from message');
                        }
                    }

                    await this.publishEvent(taskId, "execution_error", errorData, metadata);

                    /**
                     * Acknowledge failed tasks
                     * 
                     * We ack even on failure because:
                     * - Application errors (bad prompt) won't be fixed by retry
                     * - Prevents infinite retry loops
                     * - Backend is notified via execution_error event
                     * 
                     * Alternative: Could nack with requeue for transient errors
                     * (network issues, temporary ComfyUI unavailability)
                     */
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
