import ffmpeg from "fluent-ffmpeg";
import { Readable } from "stream";
import { OutputConversionOptions } from "./types";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import os from "os";

export async function convertMediaBuffer(
    buffer: Buffer,
    options: OutputConversionOptions
): Promise<Buffer> {
    const { format, options: conversionOptions } = options;
    const tempInput = path.join(os.tmpdir(), `${randomUUID()}.input`);
    const tempOutput = path.join(os.tmpdir(), `${randomUUID()}.${format}`);

    await fs.promises.writeFile(tempInput, buffer);

    return new Promise((resolve, reject) => {
        let command = ffmpeg(tempInput);

        if (conversionOptions) {
            // Video options
            if ("fps" in conversionOptions && conversionOptions.fps) {
                command = command.fps(conversionOptions.fps);
            }
            if ("codec" in conversionOptions && conversionOptions.codec) {
                if (format === "mp3" || format === "wav" || format === "ogg") {
                    command = command.audioCodec(conversionOptions.codec);
                } else {
                    command = command.videoCodec(conversionOptions.codec);
                }
            }
            if ("bitrate" in conversionOptions && conversionOptions.bitrate) {
                if (format === "mp3" || format === "wav" || format === "ogg") {
                    command = command.audioBitrate(conversionOptions.bitrate);
                } else {
                    command = command.videoBitrate(conversionOptions.bitrate);
                }
            }
            if ("crf" in conversionOptions && conversionOptions.crf) {
                command = command.addOption("-crf", conversionOptions.crf.toString());
            }
            if ("preset" in conversionOptions && conversionOptions.preset) {
                command = command.addOption("-preset", conversionOptions.preset);
            }
            if ("frequency" in conversionOptions && conversionOptions.frequency) {
                command = command.audioFrequency(conversionOptions.frequency);
            }
        }

        command
            .output(tempOutput)
            .on("end", async () => {
                try {
                    const outputBuffer = await fs.promises.readFile(tempOutput);
                    await fs.promises.unlink(tempInput);
                    await fs.promises.unlink(tempOutput);
                    resolve(outputBuffer);
                } catch (err) {
                    reject(err);
                }
            })
            .on("error", async (err) => {
                try {
                    if (fs.existsSync(tempInput)) await fs.promises.unlink(tempInput);
                    if (fs.existsSync(tempOutput)) await fs.promises.unlink(tempOutput);
                } catch (e) {
                    // Ignore cleanup errors
                }
                reject(err);
            })
            .run();

        // Add a timeout to prevent hanging on invalid input
        setTimeout(() => {
            command.kill("SIGKILL");
            reject(new Error("FFmpeg process timed out"));
        }, 5000);
    });
}
