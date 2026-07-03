import type { ViteDevServer } from "vite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import logStreamPlugin from "../src/log-stream-plugin";

/** Resolve the plugin's `configureServer` to a callable, regardless of object/function form. */
const runConfigureServer = (server: ViteDevServer): void => {
    const plugin = logStreamPlugin();
    const hook = plugin.configureServer;
    const fn = typeof hook === "function" ? hook : hook?.handler;

    // The plugin's configureServer is synchronous (it patches the streams and returns void).
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- synchronous hook; no promise is actually returned.
    fn?.call(plugin as never, server);
};

/**
 * Patch `process.stdout.write` with a capturing mock, run the plugin so it wraps
 * that mock, write `lines`, then restore via the server `close` handler. Returns
 * everything the underlying (captured) write received.
 */
const captureStdout = (lines: string[], { tty = false }: { tty?: boolean } = {}): string[] => {
    const received: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    const realIsTTY = process.stdout.isTTY;

    // Default non-TTY → no ANSI, so assertions can match plain text; pass
    // `{ tty: true }` to exercise the colourised path.
    process.stdout.isTTY = tty;
    process.stdout.write = (chunk: unknown): boolean => {
        received.push(typeof chunk === "string" ? chunk : String(chunk));

        return true;
    };

    const closeHandlers: (() => void)[] = [];
    const server = { httpServer: { once: (_event: string, cb: () => void) => closeHandlers.push(cb) } } as unknown as ViteDevServer;

    runConfigureServer(server);

    for (const line of lines) {
        process.stdout.write(line);
    }

    for (const cb of closeHandlers) {
        cb();
    }

    process.stdout.write = realWrite;
    process.stdout.isTTY = realIsTTY;

    return received;
};

const logLine = JSON.stringify({ function: "messages:list", level: "info", message: "hi", source: "lunora", type: "log" });

describe("logStreamPlugin", () => {
    // Pin both JSON-mode inputs: the suite itself often runs under an AI agent
    // (CLAUDECODE etc.), which would legitimately flip the plugin into raw-JSON
    // passthrough and skip the stream patch these tests exercise.
    beforeEach(() => {
        vi.stubEnv("LUNORA_AGENT_MODE", "0");
        vi.stubEnv("LUNORA_LOG_JSON", "");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("leaves the streams untouched in JSON mode (LUNORA_LOG_JSON=1)", () => {
        expect.assertions(1);

        vi.stubEnv("LUNORA_LOG_JSON", "1");

        // Raw structured event passes through unformatted for machine consumers.
        const received = captureStdout([`${logLine}\n`]);

        expect(received.join("")).toBe(`${logLine}\n`);
    });

    it("passes raw JSON through when an AI agent drives the process", () => {
        expect.assertions(1);

        vi.stubEnv("LUNORA_AGENT_MODE", "1");

        const received = captureStdout([`${logLine}\n`]);

        expect(received.join("")).toBe(`${logLine}\n`);
    });

    it("only applies in serve mode", () => {
        expect.assertions(1);

        expect(logStreamPlugin().apply).toBe("serve");
    });

    it("rewrites a lunora event line into a tagged, attributed line", () => {
        expect.assertions(1);

        const received = captureStdout([`${logLine}\n`]);

        expect(received.join("")).toBe("[lunora] messages:list  hi\n");
    });

    it("wraps the tag in a real SGR escape sequence on a TTY", () => {
        expect.assertions(2);

        const received = captureStdout([`${logLine}\n`], { tty: true }).join("");

        // The cyan (info) tag must use the actual ESC control byte (\u001B), not
        // the bare `[36m` text — the regression that printed literal escapes.
        expect(received).toBe("\u001B[36m[lunora]\u001B[0m messages:list  hi\n");
        expect(received).toContain("\u001B[");
    });

    it("passes non-lunora output through unchanged", () => {
        expect.assertions(1);

        const received = captureStdout(["vite v8 ready in 120 ms\n"]);

        expect(received.join("")).toBe("vite v8 ready in 120 ms\n");
    });

    it("rewrites only the lunora lines inside a mixed multi-line chunk", () => {
        expect.assertions(1);

        const received = captureStdout([`before\n${logLine}\nafter\n`]);

        expect(received.join("")).toBe("before\n[lunora] messages:list  hi\nafter\n");
    });

    it("restores the original write once the server closes", () => {
        expect.assertions(1);

        captureStdout([`${logLine}\n`]);

        // After restore, a lunora line written outside the patched window is untouched.
        const realWrite = process.stdout.write.bind(process.stdout);
        let seen = "";

        process.stdout.write = (chunk: unknown): boolean => {
            seen = String(chunk);

            return true;
        };
        process.stdout.write(`${logLine}\n`);
        process.stdout.write = realWrite;

        expect(seen).toBe(`${logLine}\n`);
    });
});
