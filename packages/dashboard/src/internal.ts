import type { FunctionReference } from "@cirrus/client";

/**
 * Build a {@link FunctionReference} for a reserved admin RPC path. All admin
 * RPCs are intercepted by `ShardDO` by `functionPath` regardless of which
 * client method carries them, so the dashboard routes every admin call through
 * `client.query` — a pure one-shot RPC with no optimistic/offline machinery.
 */
export const adminRef = (path: string): FunctionReference => ({ __cirrusRef: path });

/** Translate a free-text shard key into the client's call options. Empty → root shard. */
export const callOptions = (shardKey: string): { shardKey?: string } => {
    const trimmed = shardKey.trim();

    return trimmed === "" ? {} : { shardKey: trimmed };
};

/** Narrow an unknown thrown value to a human-readable message. */
export const errorMessage = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
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
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit]}`;
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

/**
 * Render a byte count compactly (e.g. `1.4 MB`). `null` renders as an em dash so
 * panels can pass an absent size straight through.
 */
export const formatBytes = (bytes: null | number | undefined): string => {
    if (bytes === null || bytes === undefined) {
        return "—";
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit]}`;
};

/**
 * Render an epoch-ms or ISO timestamp as a locale string. Absent values render
 * as `fallback` (blank by default; pass `"—"` for a placeholder); an unparseable
 * value falls back to its raw string so nothing is hidden.
 */
export const formatTimestamp = (value: null | number | string | undefined, fallback = ""): string => {
    if (value === null || value === undefined || value === "") {
        return fallback;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};
