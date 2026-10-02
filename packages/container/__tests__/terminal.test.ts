import { describe, expect, it, vi } from "vitest";

import type { ContainerProcess, ContainerSpawnOptions } from "../src/spawn";
import type { TerminalRuntime } from "../src/terminal";
import { openTerminal } from "../src/terminal";

type Listener = (event: { data?: unknown }) => void;

/** A fake server socket that records what the bridge sends and lets the test fire events. */
const fakeSocket = () => {
    const listeners = new Map<string, Listener[]>();
    const sent: unknown[] = [];
    const closed: { code?: number; reason?: string }[] = [];

    return {
        closed,
        emit: (type: string, data?: unknown) => {
            for (const listener of listeners.get(type) ?? []) {
                listener({ data });
            }
        },
        sent,
        socket: {
            accept: vi.fn<() => void>(),
            addEventListener: (type: string, listener: Listener) => {
                listeners.set(type, [...(listeners.get(type) ?? []), listener]);
            },
            close: (code?: number, reason?: string) => {
                closed.push({ code, reason });
            },
            send: (data: unknown) => {
                sent.push(data);
            },
        },
    };
};

/** Resolve once `ready()` holds — a poll that asserts nothing, so `expect.assertions` counts stay exact. */
const until = async (ready: () => boolean): Promise<void> =>
    vi.waitFor(() => {
        if (!ready()) {
            throw new Error("not yet");
        }
    });

/** A fake PTY process: stdout fed by the test, stdin recorded. */
const fakeProcess = () => {
    let push: ReadableStreamDefaultController<Uint8Array> | undefined;
    let exit: (code: number) => void = () => {};
    const written: string[] = [];
    const process: ContainerProcess = {
        exitCode: new Promise<number>((resolve) => {
            exit = resolve;
        }),
        isPty: true,
        kill: vi.fn<ContainerProcess["kill"]>(async () => {}),
        pid: 7,
        resize: vi.fn<ContainerProcess["resize"]>(async () => {}),
        stderr: null,
        stdin: new WritableStream<Uint8Array>({
            write: (chunk) => {
                written.push(new TextDecoder().decode(chunk));
            },
        }),
        stdout: new ReadableStream<Uint8Array>({
            start: (controller) => {
                push = controller;
            },
        }),
    };

    return {
        end: (code: number) => {
            push?.close();
            exit(code);
        },
        output: (text: string) => push?.enqueue(new TextEncoder().encode(text)),
        process,
        written,
    };
};

const upgradeRequest = (url = "https://app.test/terminal?cols=132&rows=50"): Request => new Request(url, { headers: { upgrade: "websocket" } });

const settle = async (): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
};

describe(openTerminal, () => {
    const setup = () => {
        const server = fakeSocket();
        const proc = fakeProcess();
        const spawn = vi.fn<(command: string, options: ContainerSpawnOptions) => Promise<ContainerProcess>>(async () => proc.process);
        const runtime: TerminalRuntime = { pair: () => ["client", server.socket], upgrade: (client) => Response.json({ client }) };

        return { proc, runtime, server, spawn };
    };

    it("answers 426 for a request that is not a WebSocket upgrade", async () => {
        expect.assertions(2);

        const { runtime, spawn } = setup();
        const response = await openTerminal(spawn, new Request("https://app.test/terminal"), {}, runtime);

        expect(response.status).toBe(426);
        expect(spawn).not.toHaveBeenCalled();
    });

    it("spawns a shell on a PTY sized from the request, and hands back the client socket", async () => {
        expect.assertions(3);

        const { runtime, server, spawn } = setup();
        const response = await openTerminal(spawn, upgradeRequest(), { cwd: "/root" }, runtime);

        expect(spawn).toHaveBeenCalledWith("sh", { cwd: "/root", env: { TERM: "xterm-256color" }, pty: { cols: 132, rows: 50 }, stdin: true });
        await expect(response.json()).resolves.toStrictEqual({ client: "client" });
        expect(server.socket.accept).toHaveBeenCalledTimes(1);
    });

    it("bridges keystrokes, resize messages and output, and closes when the shell exits", async () => {
        expect.assertions(4);

        const { proc, runtime, server, spawn } = setup();

        await openTerminal(spawn, upgradeRequest(), { command: "bash" }, runtime);

        server.emit("message", new TextEncoder().encode("ls\n").buffer);
        server.emit("message", JSON.stringify({ cols: 90, rows: 30 }));
        proc.output("file.txt\n");
        await settle();

        expect(proc.written).toStrictEqual(["ls\n"]);
        expect(proc.process.resize).toHaveBeenCalledWith(90, 30);
        expect(server.sent.map((chunk) => new TextDecoder().decode(chunk as Uint8Array))).toStrictEqual(["file.txt\n"]);

        proc.end(0);
        await settle();

        expect(server.closed).toStrictEqual([{ code: 1000, reason: "exited with code 0" }]);
    });

    it("accepts keystrokes as Blob frames and as non-resize text frames, in arrival order", async () => {
        expect.assertions(1);

        const { proc, runtime, server, spawn } = setup();

        await openTerminal(spawn, upgradeRequest(), {}, runtime);

        // `wrangler dev`'s proxy hands binary frames over as Blobs.
        server.emit("message", new Blob(["ls"]));
        server.emit("message", " -la\n");
        await until(() => proc.written.length === 2);

        expect(proc.written.join("")).toBe("ls -la\n");
    });

    it("applies a resize after the keystrokes before it and before the ones after it", async () => {
        expect.assertions(2);

        const { proc, runtime, server, spawn } = setup();
        let writtenAtResize: string[] = [];

        vi.mocked(proc.process.resize).mockImplementation(async () => {
            writtenAtResize = [...proc.written];
        });
        await openTerminal(spawn, upgradeRequest(), {}, runtime);

        // A Blob frame resolves its bytes asynchronously; the resize must still wait for it.
        server.emit("message", new Blob(["a"]));
        server.emit("message", JSON.stringify({ cols: 120, rows: 40 }));
        server.emit("message", new TextEncoder().encode("b").buffer);
        await until(() => proc.written.length === 2);

        expect(proc.written).toStrictEqual(["a", "b"]);
        expect(writtenAtResize).toStrictEqual(["a"]);
    });

    it("closes the socket when queued input outgrows the session cap", async () => {
        expect.assertions(2);

        const { proc, runtime, server, spawn } = setup();

        // A stdin that never accepts data, so every frame stays queued.
        (proc.process as { stdin: WritableStream<Uint8Array> }).stdin = new WritableStream<Uint8Array>({ write: async () => new Promise<void>(() => {}) });
        await openTerminal(spawn, upgradeRequest(), {}, runtime);

        for (let frame = 0; frame < 3; frame += 1) {
            server.emit("message", new Uint8Array(512 * 1024).buffer);
        }

        expect(server.closed).toStrictEqual([{ code: 1009, reason: "terminal input backlog too large" }]);
        expect(proc.process.kill).toHaveBeenCalledTimes(1);
    });

    it("kills the shell when the socket closes", async () => {
        expect.assertions(1);

        const { proc, runtime, server, spawn } = setup();

        await openTerminal(spawn, upgradeRequest(), {}, runtime);
        server.emit("close");

        expect(proc.process.kill).toHaveBeenCalledTimes(1);
    });
});
