import type { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { ContainerLogLine, DockerLike } from "../src/container-logs";
import { streamContainerLogs } from "../src/container-logs";

/** Yield to the microtask/timer queues so the stream's async poll + attach settle. */
const flush = async (): Promise<void> => {
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
};

/** A fake `dockerode` log stream the test drives by hand: feed bytes, fire `end`/`error`, observe `destroy`. */
class FakeStream {
    public destroyed = false;

    public stderr: undefined | Writable;

    public stdout: undefined | Writable;

    readonly #listeners = new Map<string, (() => void)[]>();

    public destroy(): void {
        this.destroyed = true;
    }

    /** Write raw bytes onto the demultiplexed stdout writable (one frame) — for splitting multi-byte chars. */
    public feedStdoutBytes(bytes: Buffer): void {
        this.stdout?.write(bytes);
    }

    /** Write bytes onto the demultiplexed stdout writable (one frame). */
    public feedStdout(text: string): void {
        this.stdout?.write(Buffer.from(text, "utf8"));
    }

    /** Write bytes onto the demultiplexed stderr writable (one frame). */
    public feedStderr(text: string): void {
        this.stderr?.write(Buffer.from(text, "utf8"));
    }

    public fire(event: "end" | "error"): void {
        for (const listener of this.#listeners.get(event) ?? []) {
            listener();
        }
    }

    public on(event: string, listener: () => void): void {
        const existing = this.#listeners.get(event) ?? [];

        existing.push(listener);
        this.#listeners.set(event, existing);
    }
}

interface FakeDocker {
    docker: DockerLike;
    /** Grab the stream attached for a given container id (after a poll cycle). */
    streamFor: (id: string) => FakeStream | undefined;
}

/** Build a fake Docker client over a fixed container list, recording the streams it hands out. */
const createFakeDocker = (running: { Id: string; Image: string }[], options: { listContainers?: () => { Id: string; Image: string }[] } = {}): FakeDocker => {
    const streams = new Map<string, FakeStream>();

    const docker: DockerLike = {
        getContainer: (id: string) => {
            return {
                logs: async () => {
                    const stream = new FakeStream();

                    streams.set(id, stream);

                    return stream;
                },
            };
        },
        listContainers: async () => (options.listContainers ? options.listContainers() : running),
        modem: {
            demuxStream: (stream, stdout, stderr) => {
                const fake = stream as unknown as FakeStream;

                fake.stdout = stdout;
                fake.stderr = stderr;
            },
        },
    };

    return { docker, streamFor: (id) => streams.get(id) };
};

const DEV_IMAGE = "cloudflare-dev/transcodercontainer:abc123";

describe("streamContainerLogs", () => {
    it("returns an inert handle and never touches docker when no containers are declared", () => {
        expect.assertions(1);

        const listContainers = vi.fn<DockerLike["listContainers"]>();
        const docker = { listContainers } as unknown as DockerLike;

        const handle = streamContainerLogs({ containers: [], docker, onLine: () => {} });

        handle.close();

        expect(listContainers).not.toHaveBeenCalled();
    });

    it("emits stdout lines as info and stderr lines as error, tagged with the export name", async () => {
        expect.assertions(2);

        const lines: ContainerLogLine[] = [];
        const { docker, streamFor } = createFakeDocker([{ Id: "c1", Image: DEV_IMAGE }]);

        const handle = streamContainerLogs({
            containers: [{ className: "TranscoderContainer", exportName: "transcoder" }],
            docker,
            onLine: (line) => lines.push(line),
            pollIntervalMs: 10,
        });

        await flush();

        const stream = streamFor("c1");

        stream?.feedStdout("encoding frame 1\n");
        stream?.feedStderr("ffmpeg warning\n");
        await flush();

        handle.close();

        expect(lines).toContainEqual({ level: "info", name: "transcoder", text: "encoding frame 1" });
        expect(lines).toContainEqual({ level: "error", name: "transcoder", text: "ffmpeg warning" });
    });

    it("buffers a line split across two frames and strips a trailing carriage return", async () => {
        expect.assertions(1);

        const lines: ContainerLogLine[] = [];
        const { docker, streamFor } = createFakeDocker([{ Id: "c1", Image: DEV_IMAGE }]);

        const handle = streamContainerLogs({
            containers: [{ className: "TranscoderContainer", exportName: "transcoder" }],
            docker,
            onLine: (line) => lines.push(line),
            pollIntervalMs: 10,
        });

        await flush();

        const stream = streamFor("c1");

        stream?.feedStdout("hello ");
        stream?.feedStdout("world\r\n");
        await flush();

        handle.close();

        expect(lines).toContainEqual({ level: "info", name: "transcoder", text: "hello world" });
    });

    it("reassembles a multi-byte character split across two frames", async () => {
        expect.assertions(1);

        const lines: ContainerLogLine[] = [];
        const { docker, streamFor } = createFakeDocker([{ Id: "c1", Image: DEV_IMAGE }]);

        const handle = streamContainerLogs({
            containers: [{ className: "TranscoderContainer", exportName: "transcoder" }],
            docker,
            onLine: (line) => lines.push(line),
            pollIntervalMs: 10,
        });

        await flush();

        const stream = streamFor("c1");
        // "café\n" — the "é" (U+00E9) is two UTF-8 bytes (0xC3 0xA9); split it
        // across two frames so a naive per-chunk `toString` would corrupt it.
        const encoded = Buffer.from("café\n", "utf8");

        stream?.feedStdoutBytes(encoded.subarray(0, 4)); // "caf" + first byte of "é"
        stream?.feedStdoutBytes(encoded.subarray(4)); // second byte of "é" + "\n"
        await flush();

        handle.close();

        expect(lines).toContainEqual({ level: "info", name: "transcoder", text: "café" });
    });

    it("ignores containers whose image is not a declared dev container", async () => {
        expect.assertions(1);

        const lines: ContainerLogLine[] = [];
        const { docker, streamFor } = createFakeDocker([
            { Id: "other", Image: "postgres:16" },
            { Id: "unknown", Image: "cloudflare-dev/somethingelse:zzz" },
        ]);

        const handle = streamContainerLogs({
            containers: [{ className: "TranscoderContainer", exportName: "transcoder" }],
            docker,
            onLine: (line) => lines.push(line),
            pollIntervalMs: 10,
        });

        await flush();
        await flush();

        handle.close();

        // Neither container matched, so nothing was attached and no lines emitted.
        expect(streamFor("other")).toBeUndefined();
    });

    it("notifies onUnavailable once while the docker engine is unreachable", async () => {
        expect.assertions(1);

        const onUnavailable = vi.fn<(message: string) => void>();
        const docker = {
            getContainer: () => {
                return { logs: async () => new FakeStream() };
            },
            listContainers: async () => {
                throw new Error("connect ENOENT /var/run/docker.sock");
            },
            modem: { demuxStream: () => {} },
        } as unknown as DockerLike;

        const handle = streamContainerLogs({
            containers: [{ className: "TranscoderContainer", exportName: "transcoder" }],
            docker,
            onLine: () => {},
            onUnavailable,
            pollIntervalMs: 5,
        });

        await flush();
        await flush();

        handle.close();

        expect(onUnavailable).toHaveBeenCalledTimes(1);
    });

    it("destroys attached streams on close", async () => {
        expect.assertions(1);

        const { docker, streamFor } = createFakeDocker([{ Id: "c1", Image: DEV_IMAGE }]);

        const handle = streamContainerLogs({
            containers: [{ className: "TranscoderContainer", exportName: "transcoder" }],
            docker,
            onLine: () => {},
            pollIntervalMs: 10,
        });

        await flush();

        handle.close();

        expect(streamFor("c1")?.destroyed).toBe(true);
    });
});
