import { afterEach, describe, expect, it, vi } from "vitest";

import type { AiRunBinding } from "../../../shared/ai-prompt";
import { runPrompt } from "../../../shared/ai-prompt";

const encoder = new TextEncoder();

/**
 * A binding that answers `stream: true` with exactly these byte chunks, in order.
 * `beforeClose` runs on the read that finds the chunks exhausted, i.e. after every
 * earlier chunk has been parsed, so it sees what was emitted before the body ended.
 */
const streamingBinding = (chunks: ReadonlyArray<string>, beforeClose: () => void): AiRunBinding => {
    return {
        run: () => {
            let next = 0;

            return Promise.resolve(
                new ReadableStream<Uint8Array>(
                    {
                        pull(controller) {
                            const chunk = chunks[next];

                            next += 1;

                            if (chunk === undefined) {
                                beforeClose();
                                controller.close();

                                return;
                            }

                            controller.enqueue(encoder.encode(chunk));
                        },
                    },
                    { highWaterMark: 0 },
                ),
            );
        },
    };
};

describe("runPrompt streaming", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("recognises a CRLF frame boundary split across reads", async () => {
        expect.assertions(1);

        const tokens: string[] = [];
        let emittedBeforeClose: string[] = [];

        // The frame's terminating blank line arrives as `\r\n\r` | `\n`, so neither
        // read holds a `\r\n\r\n` to normalise on its own.
        const binding = streamingBinding(['data: {"response":"a"}\r\n\r', "\n"], () => {
            emittedBeforeClose = [...tokens];
        });

        await runPrompt(binding, "m", "system", "user", (token) => {
            tokens.push(token);
        });

        // Emitted while the body was still open, not flushed when it ended.
        expect(emittedBeforeClose).toStrictEqual(["a"]);
    });

    it("cancels the model stream when the deadline wins", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const cancelled = vi.fn<() => void>();

        // Opens a stream and never produces nor closes it.
        const hung: AiRunBinding = {
            run: () =>
                Promise.resolve(
                    new ReadableStream<Uint8Array>({
                        cancel() {
                            cancelled();
                        },
                    }),
                ),
        };

        const failure = runPrompt(hung, "m", "system", "user", () => undefined).then(
            () => undefined,
            (error: unknown) => error as Error,
        );

        await vi.advanceTimersByTimeAsync(60_000);

        const error = await failure;

        expect(error?.message).toContain("timed out");
        expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it("cancels the model stream and rejects when the caller's signal aborts, with no deadline needed", async () => {
        expect.assertions(2);

        const cancelled = vi.fn<() => void>();
        let reading!: () => void;
        const streamRead = new Promise<void>((resolve) => {
            reading = resolve;
        });
        // Opens a stream and never produces nor closes it; `pull` fires only once
        // the reader is actually waiting on it, which is the state to abort in.
        const hung: AiRunBinding = {
            run: () =>
                Promise.resolve(
                    new ReadableStream<Uint8Array>(
                        {
                            cancel() {
                                cancelled();
                            },
                            pull() {
                                reading();
                            },
                        },
                        { highWaterMark: 0 },
                    ),
                ),
        };
        const caller = new AbortController();
        const failure = runPrompt(hung, "m", "system", "user", () => undefined, caller.signal).then(
            () => undefined,
            (error: unknown) => error as Error,
        );

        await streamRead;
        caller.abort();

        const error = await failure;

        expect(error?.message).toContain("cancelled");
        expect(cancelled).toHaveBeenCalledTimes(1);
    });

    it("never calls the model for a signal that is already aborted", async () => {
        expect.assertions(2);

        const run = vi.fn<AiRunBinding["run"]>(async () => {
            return { response: "never" };
        });
        const caller = new AbortController();

        caller.abort();

        await expect(runPrompt({ run }, "m", "system", "user", undefined, caller.signal)).rejects.toThrow("cancelled");
        expect(run).not.toHaveBeenCalled();
    });
});
