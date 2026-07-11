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

    it("keeps the newest generation's patch after a restart and fully restores on final close", () => {
        expect.assertions(2);

        // Regression: the patch was previously factory-scoped, so a `server.restart()`
        // (Vite configures + patches the NEW server before closing the OLD one) either
        // registered nothing for the new server or let the old server's close unpatch
        // the stream — Lunora log formatting silently vanished for the rest of the session.
        const received: string[] = [];
        const realWrite = process.stdout.write.bind(process.stdout);
        const realIsTTY = process.stdout.isTTY;

        process.stdout.isTTY = false;
        process.stdout.write = (chunk: unknown): boolean => {
            received.push(String(chunk));

            return true;
        };

        try {
            // ONE plugin instance drives both dev-server generations (a real restart
            // reuses the same plugin instance for inline/programmatic plugins).
            const plugin = logStreamPlugin();
            const hook = plugin.configureServer;
            const configure = typeof hook === "function" ? hook : hook?.handler;

            const makeServer = (): { close: () => void; server: ViteDevServer } => {
                const handlers: (() => void)[] = [];
                const server = { httpServer: { once: (_event: string, callback: () => void) => handlers.push(callback) } } as unknown as ViteDevServer;

                return {
                    close: () => {
                        for (const callback of handlers) {
                            callback();
                        }
                    },
                    server,
                };
            };

            const gen1 = makeServer();
            const gen2 = makeServer();

            // Restart order: the NEW server is configured before the OLD one closes.
            // eslint-disable-next-line @typescript-eslint/no-floating-promises -- synchronous hook.
            configure?.call(plugin as never, gen1.server);
            // eslint-disable-next-line @typescript-eslint/no-floating-promises -- synchronous hook.
            configure?.call(plugin as never, gen2.server);

            gen1.close();
            process.stdout.write(`${logLine}\n`);

            // The old server's close must NOT drop the new generation's patch.
            expect(received.join("")).toBe("[lunora] messages:list  hi\n");

            received.length = 0;
            gen2.close();
            process.stdout.write(`${logLine}\n`);

            // After the final server closes the stream is fully unpatched — a lunora
            // line passes through RAW, so no leftover wrapper keeps formatting once
            // the process outlives its server.
            expect(received.join("")).toBe(`${logLine}\n`);
        } finally {
            process.stdout.write = realWrite;
            process.stdout.isTTY = realIsTTY;
        }
    });

    it("restores the patch on a middleware-mode close via buildEnd (null httpServer)", () => {
        expect.assertions(2);

        // Middleware mode (programmatic API): `server.httpServer` is null, so the
        // classic `httpServer.once("close")` never fires. The patch must instead be
        // torn down from the plugin's `buildEnd` hook on the client environment.
        const received: string[] = [];
        const realWrite = process.stdout.write.bind(process.stdout);
        const realIsTTY = process.stdout.isTTY;

        process.stdout.isTTY = false;
        process.stdout.write = (chunk: unknown): boolean => {
            received.push(String(chunk));

            return true;
        };

        try {
            const plugin = logStreamPlugin();
            const configureHook = plugin.configureServer;
            const configure = typeof configureHook === "function" ? configureHook : configureHook?.handler;
            const buildEndHook = plugin.buildEnd;
            const buildEnd = typeof buildEndHook === "function" ? buildEndHook : buildEndHook?.handler;

            const clientEnvironment = { name: "client" };
            const server = { environments: { client: clientEnvironment }, httpServer: null } as unknown as ViteDevServer;

            // eslint-disable-next-line @typescript-eslint/no-floating-promises -- synchronous hook.
            configure?.call(plugin as never, server);

            process.stdout.write(`${logLine}\n`);

            // Patched while the middleware-mode server is up.
            expect(received.join("")).toBe("[lunora] messages:list  hi\n");

            // buildEnd fires for the client environment on `server.close()`.
            // eslint-disable-next-line @typescript-eslint/no-floating-promises -- synchronous hook.
            buildEnd?.call({ environment: clientEnvironment } as never);

            received.length = 0;
            process.stdout.write(`${logLine}\n`);

            // Unpatched after the middleware-mode close: the lunora line is raw.
            expect(received.join("")).toBe(`${logLine}\n`);
        } finally {
            process.stdout.write = realWrite;
            process.stdout.isTTY = realIsTTY;
        }
    });
});
