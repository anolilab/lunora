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
 * Format one SSE frame. Each ends with `\n\n`, the spec-required separator.
 *
 * `event:` is omitted for a data frame (the default event name); named events are
 * used only for the terminal sentinels, so a reader can tell "another chunk" from
 * "that was the last one" without inspecting the payload.
 */
const sseFrame = (chunk: unknown, event?: "complete" | "error"): string => {
    const data = JSON.stringify(chunk);
    const prefix = event === undefined ? "" : `event: ${event}\n`;

    return `${prefix}data: ${data}\n\n`;
};

export { SSE_HEADERS, sseFrame };
