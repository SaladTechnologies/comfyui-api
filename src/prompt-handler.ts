import { FastifyBaseLogger } from "fastify";
import {
    PromptRequestSchema,
    PromptErrorResponseSchema,
    ExecutionStatsSchema,
} from "./types";
import { z } from "zod";
import { preprocessNodes, NodeProcessError } from "./comfy-node-preprocessors";
import { telemetry } from "./telemetry";
import { runPromptAndGetOutputs, PromptOutputsWithStats } from "./comfy";
import { convertMediaBuffer } from "./media-tools";
import { convertImageBuffer } from "./image-tools";
import fsPromises from "fs/promises";
import path from "path";
import config from "./config";
import { getContentTypeFromUrl } from "./utils";
import archiver from "archiver";
import getStorageManager from "./remote-storage-manager";
import { sendWebhook } from "./event-emitters";

import { ComfyWSMessage } from "./types";

export type PromptRequest = z.infer<typeof PromptRequestSchema>;

export type ProcessedOutput = {
    images: string[];
    filenames: string[];
    stats: any;
};

export async function processPrompt(
    requestBody: PromptRequest,
    log: FastifyBaseLogger,
    onProgress?: (message: ComfyWSMessage) => void
): Promise<ProcessedOutput> {
    const remoteStorageManager = getStorageManager(log);
    let {
        prompt,
        id,
        webhook,
        webhook_v2,
        convert_output,
        compress_outputs,
        signed_url,
    } = requestBody;

    let hasSaveImage = false;
    const start = Date.now();

    try {
        const { prompt: preprocessedPrompt, hasSaveImage: saveImageFound } =
            await preprocessNodes(prompt, id, log);
        prompt = preprocessedPrompt;
        hasSaveImage = saveImageFound;
    } catch (e: NodeProcessError | any) {
        telemetry.trackFailure(Date.now() - start);
        log.error(`Failed to preprocess nodes: ${e.message}`);

        // Send webhook for preprocessing failures
        if (webhook_v2) {
            const webhookBody = {
                type: "prompt.failed",
                timestamp: new Date().toISOString(),
                id,
                prompt,
                error: e.message,
                location: e.location, // NodeProcessError might have location
            };
            // Use fire-and-forget (awaiting it might delay the throw, but we want to ensure it's sent)
            // Since we are throwing, we should probably await it or ensure it's floating but logged.
            // Given the context, floating is safer to avoid blocking the throw if webhook hangs,
            // but we want reliability. Let's use the same pattern as execution failure: just call it.
            sendWebhook(webhook_v2, webhookBody, log, 2);
        } else if (webhook) {
            const webhookBody = {
                event: "prompt.failed",
                id,
                prompt,
                error: e.message,
            };
            sendWebhook(webhook, webhookBody, log, 1);
        }

        throw e;
    }

    const preprocessTime = Date.now();
    log.debug(`Preprocessed prompt in ${preprocessTime}ms`);

    if (!hasSaveImage) {
        throw new Error(
            'Prompt must contain a node with a "filename_prefix" input, such as "SaveImage"'
        );
    }

    const postProcessOutputs = async ({
        outputs,
        stats,
    }: PromptOutputsWithStats): Promise<{
        buffers: Buffer[];
        filenames: string[];
        stats: any;
    }> => {
        stats.preprocess_time = preprocessTime - start;
        stats.comfy_round_trip_time = Date.now() - preprocessTime;
        const filenames: string[] = [];
        const fileBuffers: Buffer[] = [];
        const unlinks: Promise<void>[] = [];
        for (const originalFilename in outputs) {
            let filename = originalFilename;
            let fileBuffer = outputs[filename];
            if (convert_output) {
                try {
                    const isOutputVideoAudio = [
                        "mp4",
                        "webm",
                        "mp3",
                        "wav",
                        "ogg",
                    ].includes(convert_output.format);
                    const isInputVideoAudio =
                        /\.(mp4|mkv|avi|mov|webm|mp3|wav|ogg|flac|m4a)$/i.test(filename);

                    if (isOutputVideoAudio || isInputVideoAudio) {
                        fileBuffer = await convertMediaBuffer(fileBuffer, convert_output);
                        filename =
                            filename.replace(/\.[^/.]+$/, "") + "." + convert_output.format;
                    } else {
                        fileBuffer = await convertImageBuffer(fileBuffer, convert_output);
                        if (
                            convert_output.format === "jpg" ||
                            convert_output.format === "jpeg"
                        ) {
                            filename = filename.replace(/\.[^/.]+$/, "") + ".jpg";
                        } else if (convert_output.format === "webp") {
                            filename = filename.replace(/\.[^/.]+$/, "") + ".webp";
                        }
                    }
                } catch (e: any) {
                    log.warn(`Failed to convert image: ${e.message}`);
                }
            }
            filenames.push(filename);
            fileBuffers.push(fileBuffer);
            unlinks.push(
                fsPromises.unlink(path.join(config.outputDir, originalFilename))
            );
        }
        await Promise.all(unlinks);
        stats.postprocess_time =
            Date.now() - stats.comfy_round_trip_time - preprocessTime;
        if (compress_outputs) {
            const archive = archiver("zip", { zlib: { level: 9 } });
            const buffers: Buffer[] = [];
            archive.on("data", (data) => buffers.push(data));

            const archivePromise = new Promise<void>((resolve, reject) => {
                archive.on("end", resolve);
                archive.on("error", reject);
            });

            for (let i = 0; i < filenames.length; i++) {
                archive.append(fileBuffers[i], { name: filenames[i] });
            }
            archive.finalize();
            await archivePromise;

            return {
                buffers: [Buffer.concat(buffers)],
                filenames: ["outputs.zip"],
                stats,
            };
        }

        return {
            buffers: fileBuffers,
            filenames,
            stats,
        };
    };

    const runPromptPromise = runPromptAndGetOutputs(id, prompt, log, onProgress)
        .catch((e: any) => {
            telemetry.trackFailure(Date.now() - start);
            log.error(`Failed to run prompt: ${e.message}`);
            if (webhook_v2) {
                const webhookBody = {
                    type: "prompt.failed",
                    timestamp: new Date().toISOString(),
                    id,
                    prompt,
                    error: e.message,
                };
                sendWebhook(webhook_v2, webhookBody, log, 2);
            } else if (webhook) {
                log.warn(
                    `.webhook has been deprecated in favor of .webhook_v2. Support for .webhook will be removed in a future version.`
                );
                const webhookBody = {
                    event: "prompt.failed",
                    id,
                    prompt,
                    error: e.message,
                };
                sendWebhook(webhook, webhookBody, log, 1);
            }
            throw e;
        })
        .then(postProcessOutputs);

    let uploadPromise: Promise<{
        images: string[];
        filenames: string[];
        stats: any;
    }> | null = null;

    type Handler = (data: {
        buffers: Buffer[];
        filenames: string[];
        stats: any;
    }) => Promise<{
        images: string[];
        filenames: string[];
        stats: any;
    }>;

    const webhookHandler: Handler = async ({
        buffers,
        filenames,
        stats,
    }: {
        buffers: Buffer[];
        filenames: string[];
        stats: any;
    }) => {
        if (!webhook) {
            throw new Error("Webhook URL is not defined");
        }
        log.warn(
            `.webhook has been deprecated in favor of .webhook_v2. Support for .webhook will be removed in a future version.`
        );
        const webhookPromises: Promise<any>[] = [];
        const images: string[] = [];
        for (let i = 0; i < buffers.length; i++) {
            const base64File = buffers[i].toString("base64");
            images.push(base64File);
            const filename = filenames[i];
            log.info(`Sending image ${filename} to webhook: ${webhook}`);
            webhookPromises.push(
                sendWebhook(
                    webhook,
                    {
                        event: "output.complete",
                        image: base64File,
                        id,
                        filename,
                        prompt,
                        stats,
                    },
                    log,
                    1
                )
            );
        }
        await Promise.all(webhookPromises);
        return { images, filenames, stats };
    };

    const uploadHandler: Handler = async ({
        buffers,
        filenames,
        stats,
    }): Promise<{
        images: string[];
        filenames: string[];
        stats: any;
    }> => {
        const uploadPromises: Promise<void>[] = [];
        const images: string[] = [];
        for (let i = 0; i < buffers.length; i++) {
            const fileBuffer = buffers[i];
            const filename = filenames[i];
            for (const provider of remoteStorageManager.storageProviders) {
                if (
                    provider.requestBodyUploadKey &&
                    (requestBody as any)[provider.requestBodyUploadKey]
                ) {
                    images.push(
                        provider.createUrl({
                            ...(requestBody as any)[provider.requestBodyUploadKey],
                            filename,
                        })
                    );
                    break;
                }
            }
            // Get MIME type from filename to ensure correct Content-Type for audio/video files
            const mimeType = getContentTypeFromUrl(filename);
            uploadPromises.push(
                remoteStorageManager.uploadFile(images[i], fileBuffer, mimeType)
            );
        }

        await Promise.all(uploadPromises);
        return { images, filenames, stats };
    };

    const storageProvider = remoteStorageManager.storageProviders.find(
        (provider) =>
            provider.requestBodyUploadKey &&
            !!(requestBody as any)[provider.requestBodyUploadKey]
    );

    if (webhook) {
        uploadPromise = runPromptPromise.then(webhookHandler);
    } else if (!!storageProvider) {
        uploadPromise = runPromptPromise.then(uploadHandler);
    } else {
        uploadPromise = runPromptPromise.then(
            async ({ buffers, filenames, stats }) => {
                const images: string[] = buffers.map((b) => b.toString("base64"));
                return { images, filenames, stats };
            }
        );
    }

    const finalStatsPromise = uploadPromise.then(
        ({ images, stats, filenames }) => {
            stats.upload_time =
                Date.now() -
                start -
                stats.preprocess_time -
                stats.comfy_round_trip_time -
                stats.postprocess_time;
            stats.total_time = Date.now() - start;
            log.debug(stats);
            telemetry.trackSuccess(stats.total_time);
            return { images, stats, filenames };
        }
    );

    const { images, stats, filenames } = await finalStatsPromise;
    if (stats.total_time) {
        log.info(`Total time: ${stats.total_time.toFixed(3)}s`);
    }

    if (signed_url) {
        const signedImages: string[] = await Promise.all(
            images.map((url) => remoteStorageManager.getSignedUrl(url))
        );
        // Replace images with signed versions
        images.splice(0, images.length, ...signedImages);
    }

    if (webhook_v2) {
        log.debug(`Sending final response to webhook_v2: ${webhook_v2}`);
        const webhookBody = {
            type: "prompt.complete",
            timestamp: new Date().toISOString(),
            ...requestBody,
            id,
            prompt,
            images,
            filenames,
            stats,
        };
        sendWebhook(webhook_v2, webhookBody, log, 2);
    }

    return { images, filenames, stats };
}
