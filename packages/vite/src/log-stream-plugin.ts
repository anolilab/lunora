import { LUNORA_EVENT_SOURCE, formatLunoraEvent } from "@lunora/config";
import type { Plugin } from "vite";

/**
 * Dev-only plugin that pretty-prints the Lunora runtime's structured log events
 * in the Vite terminal.
 *
 * `@cloudflare/vite-plugin` runs the worker in workerd (via miniflare) inside
 * the Vite process and forwards the worker's `console` output straight to
 * `process.stdout` / `process.stderr` — it never passes through any Lunora code,
 * so there is no plugin hook to format it. We therefore wrap the two stream
 * `write` methods for the lifetime of the dev server: a chunk carrying a
 * `{ source: "lunora" }` event line (a `ctx.log.*` call or an RPC summary) is
 * rewritten into a tagged, attributed `[lunora]` line; every other byte passes
 * through untouched and in order. The patch is removed when the server closes.
 *
 * The fast-path substring check (`"source":"lunora"`) means the common case —
 * any non-Lunora output — pays only one `String#includes` before the original
 * `write` runs, so Vite's own logging is unaffected.
 *
 * Note: unlike the CLI's `pipeChildOutput`, this does NOT line-buffer across
 * `write` calls — a lunora event split mid-line across two writes would pass
 * through as raw JSON (degraded, never corrupted). That is deliberate:
 * `process.stdout` is shared with every other writer, so holding back a partial
 * chunk to await its newline would delay or reorder unrelated output. `console`
 * emits one write per line, so a split does not happen in practice.
 */

/** Marker present in every lunora event line, derived from the shared source tag (`JSON.stringify` emits no spaces around the colon). */
const LUNORA_MARKER = `"source":"${LUNORA_EVENT_SOURCE}"`;

/**
 * SGR escape sequences, applied only when the target stream is a TTY. Each must
 * begin with the ESC control byte (`\u001B`) — without it the terminal prints
 * the literal `[31m` text instead of colourising.
 */
const ANSI = {
    error: "\u001B[31m",
    info: "\u001B[36m",
    reset: "\u001B[0m",
    warn: "\u001B[33m",
} as const;

/** A patchable byte stream — the structural subset of `tty.WriteStream` we touch. */
interface WritableLike {
    isTTY?: boolean;
    write: (...args: unknown[]) => boolean;
}

/** Decorate a formatted line with the `[lunora]` tag, colourised by level when `colour` is on. */
const decorate = (text: string, level: "error" | "info" | "warn", colour: boolean): string =>
    colour ? `${ANSI[level]}[lunora]${ANSI.reset} ${text}` : `[lunora] ${text}`;

/** Coerce a `write` chunk argument to text, or `undefined` when it isn't a string/Buffer. */
const chunkToText = (chunk: unknown): string | undefined => {
    if (typeof chunk === "string") {
        return chunk;
    }

    return Buffer.isBuffer(chunk) ? chunk.toString("utf8") : undefined;
};

/**
 * Rewrite any lunora event lines inside a chunk, leaving the line structure
 * (and every non-lunora line) intact. Splitting on `\n` and re-joining preserves
 * the original newline layout, including a trailing newline.
 */
const rewriteChunk = (text: string, colour: boolean): string =>
    text
        .split("\n")
        .map((segment) => {
            const formatted = formatLunoraEvent(segment);

            return formatted ? decorate(formatted.text, formatted.level, colour) : segment;
        })
        .join("\n");

/** Build a `write` replacement that reformats lunora lines and delegates everything else to `original`. */
const wrapWrite =
    (original: WritableLike["write"], colour: boolean): WritableLike["write"] =>
    (...args: unknown[]): boolean => {
        try {
            const text = chunkToText(args[0]);

            if (text?.includes(LUNORA_MARKER)) {
                return original(rewriteChunk(text, colour), ...args.slice(1));
            }
        } catch {
            // Any failure falls through to the untouched original write below.
        }

        return original(...args);
    };

/** Patch one stream's `write` in place; returns a function that restores the original. */
const patchStream = (stream: WritableLike): (() => void) => {
    const original = stream.write.bind(stream);

    // eslint-disable-next-line no-param-reassign -- intentional, reversible monkey-patch of the live stream; restored on server close.
    stream.write = wrapWrite(original, stream.isTTY === true);

    return () => {
        // eslint-disable-next-line no-param-reassign -- restore the original write captured above.
        stream.write = original;
    };
};

/**
 * Vite plugin (serve-only) that formats Lunora worker logs in the terminal.
 * Patches `process.stdout`/`process.stderr` once the dev server is configured
 * and restores them when it closes.
 */
const logStreamPlugin = (): Plugin => {
    let restore: (() => void) | undefined;

    return {
        apply: "serve",
        configureServer(server) {
            if (restore) {
                return;
            }

            const restoreStdout = patchStream(process.stdout as unknown as WritableLike);
            const restoreStderr = patchStream(process.stderr as unknown as WritableLike);

            restore = () => {
                restoreStdout();
                restoreStderr();
                restore = undefined;
            };

            // Unpatch on shutdown so the streams aren't left wrapped if the same
            // process outlives the server (e.g. Vite's programmatic API).
            server.httpServer?.once("close", () => {
                restore?.();
            });
        },
        name: "lunora:log-stream",
    };
};

export default logStreamPlugin;
