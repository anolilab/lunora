import type { FunctionReference } from "@cirrus/client";

/**
 * Build a {@link FunctionReference} for a reserved admin RPC path. All admin
 * RPCs are intercepted by `ShardDO` by `functionPath` regardless of which
 * client method carries them, so the studio routes every admin call through
 * `client.query` — a pure one-shot RPC with no optimistic/offline machinery.
 */
export const adminRef = (path: string): FunctionReference => {
    return { __cirrusRef: path };
};

/** Translate a free-text shard key into the client's call options. Empty → root shard. */
export const callOptions = (shardKey: string): { shardKey?: string } => {
    const trimmed = shardKey.trim();

    return trimmed === "" ? {} : { shardKey: trimmed };
};

/** Narrow an unknown thrown value to a human-readable message. */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Render a single table-cell value as text without throwing on objects or null.
 * Shared by the shard and global data browsers so cell rendering can't drift
 * between them.
 */
export const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }

    switch (typeof value) {
        case "bigint":
        case "boolean":
        case "number": {
            return value.toString();
        }
        case "string": {
            return value;
        }
        case "symbol": {
            return value.toString();
        }
        default: {
            return JSON.stringify(value);
        }
    }
};

/**
 * Fire a promise without awaiting it, so an event handler or effect can kick one
 * off and return `void` without leaving a floating promise.
 *
 * By default the studio's async loaders already surface their own errors into
 * panel state via internal try/catch, so the rejection is swallowed here. For a
 * promise that does *not* self-handle (a bare mutation/migration/import/delete),
 * pass `onError` to route the failure into the calling panel's error surface —
 * otherwise it would silently no-op. New state-changing call sites should pass
 * `onError`; navigation and self-handling loaders intentionally stay silent.
 */
export const fireAndForget = (promise: Promise<unknown>, onError?: (error: unknown) => void): void => {
    promise.catch((error: unknown) => {
        onError?.(error);
        /* default: loaders surface their own errors into panel state */
    });
};

/**
 * Copy `text` to the clipboard when the browser exposes one; a no-op under
 * SSR/tests without `navigator`. The single home for the studio's copy buttons
 * so the (browser-only) guard and its lint exception live in one place.
 */
export const copyToClipboard = (text: string): void => {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard, guarded by the "navigator" in globalThis check
    const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

    if (clipboard !== undefined) {
        fireAndForget(clipboard.writeText(text));
    }
};

/**
 * Render a byte count compactly (e.g. `1.4 MB`). `null`/`undefined` render as an
 * em dash so panels can pass an absent size straight through.
 */
export const formatBytes = (bytes: null | number | undefined): string => {
    if (bytes === null || bytes === undefined) {
        return "—";
    }

    if (bytes < 1024) {
        return `${bytes.toString()} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit] ?? "TB"}`;
};

/**
 * Render an epoch-ms or ISO timestamp as a locale string. Absent values render
 * as `fallback` (blank by default; pass `"—"` for a placeholder); an
 * unparseable value falls back to its raw string so nothing is hidden.
 */
export const formatTimestamp = (value: null | number | string | undefined, fallback = ""): string => {
    if (value === null || value === undefined || value === "") {
        return fallback;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};
