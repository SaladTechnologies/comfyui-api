import assert from "assert";
import archiver from "archiver";
import { PassThrough } from "stream";

describe("Compression Logic", () => {
    it("should create a valid zip file", async () => {
        const archive = archiver("zip", { zlib: { level: 9 } });
        const buffers: Buffer[] = [];
        archive.on("data", (data) => buffers.push(data));

        const archivePromise = new Promise<void>((resolve, reject) => {
            archive.on("end", resolve);
            archive.on("error", reject);
        });

        archive.append(Buffer.from("test content"), { name: "test.txt" });
        archive.finalize();
        await archivePromise;

        const zipBuffer = Buffer.concat(buffers);
        assert.ok(zipBuffer.length > 0);
        // Check for PK header
        assert.strictEqual(zipBuffer.toString("hex", 0, 4), "504b0304");
    });
});
