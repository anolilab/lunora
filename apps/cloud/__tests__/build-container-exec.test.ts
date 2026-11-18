import type { ContainerAccessor, ContainerInstanceHandle } from "@lunora/container";
import { describe, expect, it, vi } from "vitest";

import { executeInContainer, executeOnOwnBox } from "../src/builds/container-exec";

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

        const execution = await executeInContainer(handle, SOURCE, undefined, onLine);

        expect(execution).toStrictEqual({ bundle: "YmFzZTY0", bundleHash: "abc123" });
        expect(onLine.mock.calls.map(([line]) => line)).toStrictEqual(["extracting source", "installing dependencies with pnpm"]);
    });

    it("reassembles a payload split across two reads", async () => {
        expect.assertions(2);

        const onLine = vi.fn<(line: string) => Promise<void>>().mockResolvedValue();
        // The split lands mid-key and mid-value — where a per-chunk parser breaks.
        const handle = streaming(['{"line":"running lun', 'ora build"}\n{"bundle":"YmFz', 'ZTY0","bundleHash":"abc123"}\n']);

        const execution = await executeInContainer(handle, SOURCE, undefined, onLine);

        expect(execution.bundleHash).toBe("abc123");
        expect(onLine).toHaveBeenCalledWith("running lunora build");
    });

    it("turns a reported error into a throw, so the build is failed", async () => {
        expect.assertions(1);

        const handle = streaming(['{"line":"running lunora build"}\n', '{"error":"no lockfile found"}\n']);

        await expect(executeInContainer(handle, SOURCE, undefined, vi.fn().mockResolvedValue(undefined))).rejects.toThrow("no lockfile found");
    });

    it("fails loudly when the stream ends with no bundle and no error", async () => {
        expect.assertions(1);

        // What an OOM-killed container looks like from here. Reporting it beats
        // a type error three frames later on an undefined bundle.
        const handle = streaming(['{"line":"installing dependencies with pnpm"}\n']);

        await expect(executeInContainer(handle, SOURCE, undefined, vi.fn().mockResolvedValue(undefined))).rejects.toThrow(/without producing a bundle/u);
    });

    it("reports a non-JSON line without failing a build that may still succeed", async () => {
        expect.assertions(2);

        const onLine = vi.fn<(line: string) => Promise<void>>().mockResolvedValue();
        const handle = streaming(["not json at all\n", '{"bundle":"YmFzZTY0","bundleHash":"abc123"}\n']);

        const execution = await executeInContainer(handle, SOURCE, undefined, onLine);

        expect(execution.bundleHash).toBe("abc123");
        expect(onLine).toHaveBeenCalledWith(expect.stringContaining("not JSON"));
    });

    it("returns the whole release the box reports — manifest, assets, crons and the script name", async () => {
        expect.assertions(1);

        const release = {
            assets: { files: [{ content: "aGk=", path: "/index.html" }] },
            bundle: "YmFzZTY0",
            bundleHash: "abc123",
            cronSpecs: ["0 0 * * *"],
            manifest: { bindings: [{ binding: "DB", type: "d1" }], compatibilityDate: "2026-01-01" },
            scriptName: "app",
            workspacePackages: ["packages/ui"],
        };

        await expect(
            executeInContainer(streaming([`${JSON.stringify(release)}\n`]), SOURCE, undefined, vi.fn().mockResolvedValue(undefined)),
        ).resolves.toStrictEqual(release);
    });

    it("drops release fields of the wrong shape rather than passing them on", async () => {
        expect.assertions(1);

        const line = JSON.stringify({
            bundle: "YmFzZTY0",
            bundleHash: "abc123",
            cronSpecs: ["0 0 * * *", 7],
            manifest: ["not", "an", "object"],
            scriptName: "",
            workspacePackages: ["packages/ui", 7],
        });

        // The deploy path validates the contents; this only refuses to forward a
        // manifest that is not an object or a cron that is not a string.
        await expect(executeInContainer(streaming([`${line}\n`]), SOURCE, undefined, vi.fn().mockResolvedValue(undefined))).resolves.toStrictEqual({
            bundle: "YmFzZTY0",
            bundleHash: "abc123",
            cronSpecs: ["0 0 * * *"],
        });
    });

    it("still reads a bundle-only line from a box that predates release payloads", async () => {
        expect.assertions(1);

        // The build stays green; the release path is what refuses it, for want of a manifest.
        const execution = await executeInContainer(
            streaming(['{"bundle":"YmFzZTY0","bundleHash":"abc123"}\n']),
            SOURCE,
            undefined,
            vi.fn().mockResolvedValue(undefined),
        );

        expect(execution).toStrictEqual({ bundle: "YmFzZTY0", bundleHash: "abc123" });
    });

    it("throws when the box refuses the request outright", async () => {
        expect.assertions(1);

        await expect(executeInContainer(streaming(["{}"], 503), SOURCE, undefined, vi.fn().mockResolvedValue(undefined))).rejects.toThrow("503");
    });
});

describe(executeOnOwnBox, () => {
    /** An accessor that records every instance name it hands out and every instance destroyed. */
    const recordingBoxes = (): { boxes: Pick<ContainerAccessor, "get">; destroyed: string[]; names: string[] } => {
        const destroyed: string[] = [];
        const names: string[] = [];

        return {
            boxes: {
                get: (name) => {
                    names.push(name);

                    return {
                        destroy: async () => {
                            destroyed.push(name);
                        },
                    } as ContainerInstanceHandle;
                },
            },
            destroyed,
            names,
        };
    };

    it("gives each build an instance no other build shares, and destroys it after", async () => {
        expect.assertions(3);

        const { boxes, destroyed, names } = recordingBoxes();

        await executeOnOwnBox(boxes, async () => "first");
        await executeOnOwnBox(boxes, async () => "second");

        expect(names).toHaveLength(2);
        expect(new Set(names).size).toBe(2);
        expect(destroyed).toStrictEqual(names);
    });

    it("destroys the instance when the build throws, and surfaces the build's error", async () => {
        expect.assertions(2);

        const { boxes, destroyed, names } = recordingBoxes();

        await expect(executeOnOwnBox(boxes, async () => await Promise.reject(new Error("install failed")))).rejects.toThrow("install failed");
        expect(destroyed).toStrictEqual(names);
    });
});
