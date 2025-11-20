import { randomUUID } from "node:crypto";
import { request } from "undici";
import config from "./config";

interface TelemetryStats {
    machine_id: string;
    success_count: number;
    failure_count: number;
    total_duration_ms: number;
    timestamp: string;
    comfyui_api_version: string;
}

export class TelemetryManager {
    private successCount = 0;
    private failureCount = 0;
    private totalDuration = 0;
    private machineId: string;
    private intervalId: NodeJS.Timeout | null = null;

    constructor() {
        this.machineId = config.saladMetadata?.machineId || randomUUID();
        if (config.enableTelemetry && config.telemetryUrl) {
            this.startReporting();
        }
    }

    public trackSuccess(durationMs: number) {
        if (!config.enableTelemetry) return;
        this.successCount++;
        this.totalDuration += durationMs;
    }

    public trackFailure(durationMs: number) {
        if (!config.enableTelemetry) return;
        this.failureCount++;
        this.totalDuration += durationMs;
    }

    private startReporting() {
        this.intervalId = setInterval(() => {
            this.reportStats();
        }, config.telemetryInterval);
    }

    private async reportStats() {
        if (this.successCount === 0 && this.failureCount === 0) return;

        const stats: TelemetryStats = {
            machine_id: this.machineId,
            success_count: this.successCount,
            failure_count: this.failureCount,
            total_duration_ms: this.totalDuration,
            timestamp: new Date().toISOString(),
            comfyui_api_version: config.apiVersion,
        };

        try {
            await request(config.telemetryUrl!, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(stats),
            });

            // Reset stats after successful report
            this.successCount = 0;
            this.failureCount = 0;
            this.totalDuration = 0;
        } catch (error) {
            console.error("Failed to send telemetry:", error);
        }
    }

    public stopReporting() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}

export const telemetry = new TelemetryManager();
