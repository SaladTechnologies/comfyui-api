export class TaskQueue {
    private concurrency: number;
    private running: number;
    private queue: (() => void)[];

    constructor(concurrency: number) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    add<T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            const run = async () => {
                this.running++;
                try {
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    this.running--;
                    this.next();
                }
            };

            if (this.running < this.concurrency) {
                run();
            } else {
                this.queue.push(run);
            }
        });
    }

    private next() {
        if (this.running < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            if (task) {
                task();
            }
        }
    }
}
