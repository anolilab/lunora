import { describe, expect, it, vi } from "vitest";

import { executeInContainer } from "../src/builds/container-exec";

/**
 * Reading the build box's NDJSON reply.
 *
 * The case that drives the design is the last one: a streaming body splits
 * wherever the network decides, so a JSON object arriving in two reads is
 * normal traffic, not an edge case. A reader that parsed per chunk would fail
 * builds at random under load and pass every test written with one chunk.
 */

/** A response whose body yields exactly these chunks, in order. */
const streaming = (chunks: ReadonlyArray<string>, status = 200): { fetch: (path: string, init?: RequestInit) => Promise<Response> } => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }

            controller.close();
        },
    });

    return { fetch: async () => new Response(body, { status }) };
};

const SOURCE = new ArrayBuffer(8);

describe(executeInContainer, () => {
    it("streams every log line in order and returns the bundle", async () => {
        expect.assertions(2);

        const onLine = vi.fn<(line: string) => Promise<void>>().mockResolvedValue();
        const handle = streaming([
            '{"line":"extracting source"}\n',
            '{"line":"installing dependencies with pnpm"}\n',
            '{"bundle":"YmFzZTY0","bundleHash":"abc123"}\n',
        ]);

        const execution = await executeInContainer(handle, SOURCE, onLine);

        expect(execution).toStrictEqual({ bundle: "YmFzZTY0", bundleHash: "abc123" });
        expect(onLine.mock.calls.map(([line]) => line)).toStrictEqual(["extracting source", "installing dependencies with pnpm"]);
    });

    it("reassembles a payload split across two reads", async () => {
        expect.assertions(2);

        const onLine = vi.fn<(line: string) => Promise<void>>().mockResolvedValue();
        // The split lands mid-key and mid-value — where a per-chunk parser breaks.
        const handle = streaming(['{"line":"running lun', 'ora build"}\n{"bundle":"YmFz', 'ZTY0","bundleHash":"abc123"}\n']);

        const execution = await executeInContainer(handle, SOURCE, onLine);

        expect(execution.bundleHash).toBe("abc123");
        expect(onLine).toHaveBeenCalledWith("running lunora build");
    });

    it("turns a reported error into a throw, so the build is failed", async () => {
        expect.assertions(1);

        const handle = streaming(['{"line":"running lunora build"}\n', '{"error":"no lockfile found"}\n']);

        await expect(executeInContainer(handle, SOURCE, vi.fn().mockResolvedValue(undefined))).rejects.toThrow("no lockfile found");
    });

    it("fails loudly when the stream ends with no bundle and no error", async () => {
        expect.assertions(1);

        // What an OOM-killed container looks like from here. Reporting it beats
        // a type error three frames later on an undefined bundle.
        const handle = streaming(['{"line":"installing dependencies with pnpm"}\n']);

        await expect(executeInContainer(handle, SOURCE, vi.fn().mockResolvedValue(undefined))).rejects.toThrow(/without producing a bundle/u);
    });

    it("reports a non-JSON line without failing a build that may still succeed", async () => {
        expect.assertions(2);

        const onLine = vi.fn<(line: string) => Promise<void>>().mockResolvedValue();
        const handle = streaming(["not json at all\n", '{"bundle":"YmFzZTY0","bundleHash":"abc123"}\n']);

        const execution = await executeInContainer(handle, SOURCE, onLine);

        expect(execution.bundleHash).toBe("abc123");
        expect(onLine).toHaveBeenCalledWith(expect.stringContaining("not JSON"));
    });

    it("throws when the box refuses the request outright", async () => {
        expect.assertions(1);

        await expect(executeInContainer(streaming(["{}"], 503), SOURCE, vi.fn().mockResolvedValue(undefined))).rejects.toThrow("503");
    });
});
