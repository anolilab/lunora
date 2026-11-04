/**
 * The `text/event-stream` framing every Lunora streaming HTTP response writes.
 *
 * Two writers exist — `@lunora/server`'s `httpRoute…stream()` pump and
 * `@lunora/runtime`'s assistant turn — and ONE reader parses both
 * (`@lunora/client`'s `pumpSseBody`). Framing that lives in each writer is
 * framing that eventually disagrees with the reader in exactly one of them, so it
 * lives here instead: `shared/` rather than a package because both writers would
 * otherwise need a dependency edge on each other's, and the bytes are inlined
 * into each bundle.
 *
 * Dependency-free by construction, like every other file in this folder.
 */

/**
 * Headers on every SSE response.
 *
 * SSE responses must stay uncacheable so proxies don't buffer or coalesce live
 * frames; `x-accel-buffering` hints the same to proxies that honour it
 * (Cloudflare's own buffering layer among them).
 */
const SSE_HEADERS: Record<string, string> = {
    "cache-control": "no-cache, no-transform",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
};

/**
 * Whether a value can sit on one SSE field line. A CR, LF or NUL would end the
 * line early and let the value inject `event:` / `data:` lines of its own.
 */
const isSafeHeaderValue = (value: string): boolean => !(value.includes("\r") || value.includes("\n") || value.includes("\0"));

/**
 * Format one SSE frame. Each ends with `\n\n`, the spec-required separator.
 *
 * `event:` is omitted for a data frame (the default event name); named events are
 * used only for the terminal sentinels, so a reader can tell "another chunk" from
 * "that was the last one" without inspecting the payload. `id:` is written only
 * when given, and an id that is not a safe field value throws.
 */
const sseFrame = (chunk: unknown, event?: "complete" | "error", id?: string): string => {
    if (id !== undefined && !isSafeHeaderValue(id)) {
        throw new Error("SSE event id must not contain CR, LF or NUL");
    }

    const data = JSON.stringify(chunk);
    const idLine = id === undefined ? "" : `id: ${id}\n`;
    const prefix = event === undefined ? "" : `event: ${event}\n`;

    return `${idLine}${prefix}data: ${data}\n\n`;
};

export { isSafeHeaderValue, SSE_HEADERS, sseFrame };
