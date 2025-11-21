import assert from "node:assert";
import { TaskQueue } from "../src/task-queue";

describe("TaskQueue", () => {
    it("should run tasks immediately if concurrency limit is not reached", async () => {
        const queue = new TaskQueue(2);
        const start = Date.now();
        const task1 = queue.add(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 1;
        });
        const task2 = queue.add(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 2;
        });

        const results = await Promise.all([task1, task2]);
        const duration = Date.now() - start;

        assert.deepStrictEqual(results, [1, 2]);
        assert.ok(duration < 30, "Tasks should run in parallel");
    });

    it("should queue tasks if concurrency limit is reached", async () => {
        const queue = new TaskQueue(1);
        const start = Date.now();
        const task1 = queue.add(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return 1;
        });
        const task2 = queue.add(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return 2;
        });

        const results = await Promise.all([task1, task2]);
        const duration = Date.now() - start;

        assert.deepStrictEqual(results, [1, 2]);
        assert.ok(duration >= 40, "Tasks should run sequentially");
    });

    it("should handle task errors", async () => {
        const queue = new TaskQueue(1);
        const task1 = queue.add(async () => {
            throw new Error("Task failed");
        });
        const task2 = queue.add(async () => {
            return 2;
        });

        await assert.rejects(task1, /Task failed/);
        const result2 = await task2;
        assert.strictEqual(result2, 2);
    });
});
