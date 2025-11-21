import assert from "assert";
import { AmqpClient } from "../src/amqp-client";
import config from "../src/config";
import { FastifyBaseLogger } from "fastify";

describe("AmqpClient", () => {
    let amqpClient: AmqpClient;
    let mockLog: FastifyBaseLogger;
    let mockConnection: any;
    let mockChannel: any;
    let connectFn: (url: string) => Promise<any>;
    let connectCalledWith: string | undefined;

    beforeEach(() => {
        mockLog = {
            info: () => { },
            error: () => { },
            warn: () => { },
            debug: () => { },
            fatal: () => { },
            trace: () => { },
            child: () => mockLog,
        } as unknown as FastifyBaseLogger;

        mockChannel = {
            assertQueue: async (queue: string, options: any) => { },
            consume: async (queue: string, callback: any) => { },
            sendToQueue: (queue: string, content: Buffer, options: any) => { },
            ack: (msg: any) => { },
            nack: (msg: any, allUpTo: boolean, requeue: boolean) => { },
            close: async () => { },
        };

        mockConnection = {
            createChannel: async () => mockChannel,
            close: async () => { },
        };

        connectCalledWith = undefined;
        connectFn = async (url: string) => {
            connectCalledWith = url;
            return mockConnection;
        };

        // Mock config
        config.amqpUrl = "amqp://localhost";
        config.amqpQueueInput = "test_input";
        config.amqpQueueOutput = "test_output";

        amqpClient = new AmqpClient(mockLog, connectFn);
    });

    it("should connect to AMQP broker", async () => {
        let channelCreated = false;
        let queueAsserted = 0;
        let consumeCalled = false;

        mockConnection.createChannel = async () => {
            channelCreated = true;
            return mockChannel;
        };

        mockChannel.assertQueue = async (queue: string) => {
            if (queue === "test_input" || queue === "test_output") {
                queueAsserted++;
            }
        };

        mockChannel.consume = async (queue: string) => {
            if (queue === "test_input") {
                consumeCalled = true;
            }
        };

        await amqpClient.connect();

        assert.strictEqual(connectCalledWith, "amqp://localhost");
        assert.strictEqual(channelCreated, true);
        assert.strictEqual(queueAsserted, 2);
        assert.strictEqual(consumeCalled, true);
    });

    it("should log warning if AMQP URL is not configured", async () => {
        config.amqpUrl = undefined;
        let warnCalled = false;
        mockLog.warn = (msg: string) => {
            if (msg.includes("AMQP URL not configured")) {
                warnCalled = true;
            }
        };

        await amqpClient.connect();

        assert.strictEqual(connectCalledWith, undefined);
        assert.strictEqual(warnCalled, true);
    });

    it("should handle connection errors", async () => {
        connectFn = async () => {
            throw new Error("Connection failed");
        };
        amqpClient = new AmqpClient(mockLog, connectFn);

        let errorLogged = false;
        mockLog.error = (msg: string) => {
            if (msg.includes("Failed to connect to AMQP broker")) {
                errorLogged = true;
            }
        };

        await amqpClient.connect();

        assert.strictEqual(errorLogged, true);
    });

    it("should handle invalid JSON", async () => {
        let consumeCallback: any;
        mockChannel.consume = async (queue: string, cb: any) => {
            consumeCallback = cb;
        };

        await amqpClient.connect();

        const mockMsg = {
            content: Buffer.from("invalid json"),
            properties: { correlationId: "abc" },
        };

        let nackCalled = false;
        mockChannel.nack = (msg: any, allUpTo: boolean, requeue: boolean) => {
            if (msg === mockMsg && requeue === false) {
                nackCalled = true;
            }
        };

        let errorLogged = false;
        mockLog.error = (msg: string) => {
            if (msg.includes("Failed to parse AMQP message content")) {
                errorLogged = true;
            }
        };

        await consumeCallback(mockMsg);

        assert.strictEqual(errorLogged, true);
        assert.strictEqual(nackCalled, true);
    });
});
