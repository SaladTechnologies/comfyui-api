import assert from "assert";
import { TelemetryManager } from "../src/telemetry";
import config from "../src/config";

// Mock config
const originalEnableTelemetry = config.enableTelemetry;
const originalTelemetryUrl = config.telemetryUrl;

describe("TelemetryManager", () => {
    beforeEach(() => {
        // Reset config
        (config as any).enableTelemetry = true;
        (config as any).telemetryUrl = "http://localhost:9999/telemetry";
    });

    afterEach(() => {
        // Restore config
        (config as any).enableTelemetry = originalEnableTelemetry;
        (config as any).telemetryUrl = originalTelemetryUrl;
    });

    it("should track success", () => {
        const telemetry = new TelemetryManager();
        telemetry.trackSuccess(100);
        // Access private property for testing (using any cast)
        assert.strictEqual((telemetry as any).successCount, 1);
        assert.strictEqual((telemetry as any).totalDuration, 100);
    });

    it("should track failure", () => {
        const telemetry = new TelemetryManager();
        telemetry.trackFailure(200);
        assert.strictEqual((telemetry as any).failureCount, 1);
        assert.strictEqual((telemetry as any).totalDuration, 200);
    });

    it("should not track if disabled", () => {
        (config as any).enableTelemetry = false;
        const telemetry = new TelemetryManager();
        telemetry.trackSuccess(100);
        assert.strictEqual((telemetry as any).successCount, 0);
    });
});
