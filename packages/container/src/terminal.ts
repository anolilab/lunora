/**
 * `handle.terminal()`: a browser terminal over a WebSocket, bridged to a
 * process spawned on a PTY.
 *
 * Built on the caller's side of `spawn`, not inside the container Durable
 * Object: the caller creates the `WebSocketPair` and pumps it against the
 * process's streams, which do cross RPC. That way no WebSocket has to cross
 * RPC, and the terminal never needs a route on the Durable Object's `fetch`,
 * which refuses Lunora's reserved paths for exactly the reason a terminal
 * route would be dangerous there.
 *
 * Wire protocol, matching Cloudflare's Sandbox terminal guide and xterm.js:
 * a **binary** frame is keystrokes for stdin; a **text** frame that is the
 * JSON control message `{ "cols": n, "rows": n }` resizes the PTY, and any
 * other text frame is keystrokes too (many xterm.js setups send text). Output
 * arrives as binary frames. The socket closes with `1000` when the process
 * exits, and closing the socket kills the process.
 */
import type { ContainerProcess, ContainerSpawnOptions } from "./spawn";

/** Options for `handle.terminal()`. */
interface ContainerTerminalOptions extends Omit<ContainerSpawnOptions, "pty" | "signal" | "stdin"> {
    /** Initial size. Defaults to the request's `?cols=&rows=` search params, else `80×24`. */
    cols?: number;
    /** The program to run. Defaults to `"sh"`. */
    command?: string;
    /** Initial size. Defaults to the request's `?cols=&rows=` search params, else `80×24`. */
    rows?: number;
}

/** Structural view of one end of a `WebSocketPair` — what the bridge uses. */
interface TerminalSocket {
    accept: () => void;
    addEventListener: (type: "close" | "error" | "message", listener: (event: { data?: unknown }) => void) => void;
    close: (code?: number, reason?: string) => void;
    send: (data: ArrayBuffer | ArrayBufferView | string) => void;
}

/**
 * What the bridge needs from the runtime: a `[client, server]` socket pair and
 * the `101` response that hands the client end back. Injected so the bridge is
 * testable outside workerd, which is the only place either exists.
 */
interface TerminalRuntime {
    pair: () => [client: unknown, server: TerminalSocket];
    upgrade: (client: unknown) => Response;
}

/**
 * Keystrokes queued for stdin but not yet written, per session. Frames queue
 * while stdin is not accepting data, and the runtime's 32 MiB limit is per
 * message, not per session, so without a cap one client could grow the
 * isolate's memory frame by frame. Past it the socket closes with `1009`.
 */
const MAX_QUEUED_INPUT_BYTES = 1_048_576;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** A positive integer from a search param, else `undefined`. */
const sizeParameter = (url: URL, name: string): number | undefined => {
    const value = Number(url.searchParams.get(name));

    return Number.isInteger(value) && value > 0 ? value : undefined;
};

const workerdRuntime: TerminalRuntime = {
    pair: () => {
        const { WebSocketPair } = globalThis as unknown as { WebSocketPair?: new () => Record<0 | 1, unknown> };

        if (WebSocketPair === undefined) {
            throw new TypeError("terminal(): WebSocketPair is not available — open a terminal from a Worker or Durable Object");
        }

        const pair = new WebSocketPair();

        return [pair[0], pair[1] as TerminalSocket];
    },
    upgrade: (client) => new Response(undefined, { status: 101, webSocket: client } as ResponseInit),
};

/** A `{ cols, rows }` resize message, or `undefined` when the text frame is not one. */
const parseResize = (text: string): { cols: number; rows: number } | undefined => {
    try {
        const message = JSON.parse(text) as { cols?: unknown; rows?: unknown };

        return Number.isInteger(message.cols) && Number.isInteger(message.rows) ? { cols: message.cols as number, rows: message.rows as number } : undefined;
    } catch {
        return undefined;
    }
};

/**
 * The bytes of a binary frame. The runtime hands a frame over as an
 * `ArrayBuffer`, a view, or — behind `wrangler dev`'s proxy — a `Blob`.
 */
const frameBytes = async (data: unknown): Promise<Uint8Array | undefined> => {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    if (data instanceof Blob) {
        return new Uint8Array(await data.arrayBuffer());
    }

    return undefined;
};

/** A frame's size, known before its bytes are (a `Blob` resolves them asynchronously). */
const frameSize = (data: unknown): number => {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        return data.byteLength;
    }

    return data instanceof Blob ? data.size : 0;
};

/** Pump the process's output into the socket, then close it with the exit code. */
const pumpOutput = async (process: ContainerProcess, server: TerminalSocket): Promise<void> => {
    const reader = process.stdout?.getReader();

    try {
        while (reader !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- terminal output is forwarded in order
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            server.send(value);
        }

        const code = await process.exitCode;

        server.close(1000, `exited with code ${String(code)}`);
    } catch {
        server.close(1011, "terminal stream failed");
    }
};

/**
 * Answer a WebSocket upgrade `request` with a terminal bridged to a process
 * that `spawn` starts on a PTY. Returns `426` for a request that is not a
 * WebSocket upgrade. Authenticate the request before calling this: whoever
 * holds the socket has a shell in the container.
 */
const openTerminal = async (
    spawn: (command: string, options: ContainerSpawnOptions) => Promise<ContainerProcess>,
    request: Request,
    options: ContainerTerminalOptions = {},
    runtime: TerminalRuntime = workerdRuntime,
): Promise<Response> => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("terminal(): expected a WebSocket upgrade request", { status: 426 });
    }

    const url = new URL(request.url);
    const { command = "sh", cols, rows, ...spawnOptions } = options;
    const process = await spawn(command, {
        ...spawnOptions,
        env: { TERM: "xterm-256color", ...spawnOptions.env },
        pty: { cols: cols ?? sizeParameter(url, "cols") ?? DEFAULT_COLS, rows: rows ?? sizeParameter(url, "rows") ?? DEFAULT_ROWS },
        stdin: true,
    });
    const [client, server] = runtime.pair();
    const writer = process.stdin?.getWriter();
    const end = (): void => {
        process.kill().catch(() => undefined);
        writer?.close().catch(() => undefined);
    };

    // Every frame's effect is chained, not fired as it arrives: a Blob frame
    // resolves its bytes asynchronously, and a resize must land before the
    // keystrokes sent after it (`stty size` right after a resize should see it).
    let pending = Promise.resolve();
    const inOrder = (apply: () => Promise<void>): void => {
        pending = pending.then(apply).catch(end);
    };
    let queuedBytes = 0;
    const toStdin = (size: number, bytes: Promise<Uint8Array | undefined>): void => {
        queuedBytes += size;

        if (queuedBytes > MAX_QUEUED_INPUT_BYTES) {
            server.close(1009, "terminal input backlog too large");
            end();

            return;
        }

        inOrder(async () => {
            try {
                const chunk = await bytes;

                if (chunk !== undefined) {
                    await writer?.write(chunk);
                }
            } finally {
                queuedBytes -= size;
            }
        });
    };

    server.accept();
    server.addEventListener("message", ({ data }) => {
        if (typeof data !== "string") {
            toStdin(frameSize(data), frameBytes(data));

            return;
        }

        const size = parseResize(data);

        if (size === undefined) {
            const keystrokes = new TextEncoder().encode(data);

            toStdin(keystrokes.byteLength, Promise.resolve(keystrokes));
        } else {
            inOrder(async () => process.resize(size.cols, size.rows).catch(() => undefined));
        }
    });
    server.addEventListener("close", end);
    server.addEventListener("error", end);
    pumpOutput(process, server).catch(() => undefined);

    return runtime.upgrade(client);
};

export type { ContainerTerminalOptions, TerminalRuntime, TerminalSocket };
export { openTerminal };
