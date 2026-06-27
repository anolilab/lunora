import type { AnalyticsClient, AnalyticsEngineDataPoint, AnalyticsEngineDatasetLike, TrackColumn, TrackEvent, TrackSchema } from "./types";

/** AE's documented per-data-point ceiling on string `blobs`. */
const MAX_BLOBS = 20;

/** AE's documented per-data-point ceiling on numeric `doubles`. */
const MAX_DOUBLES = 20;

/** AE accepts exactly one `index` (the sampling key) per data point. */
const MAX_INDEXES = 1;

/**
 * AE's documented per-data-point byte ceiling on the combined `blobs`.
 * Cloudflare raised this from 5 KB to 16 KB on 2025-06-20; "KB" is base-2
 * (the prior 5 KB cap was exactly 5120 = 5 × 1024 bytes), so 16 KB = 16 × 1024.
 * @see https://developers.cloudflare.com/analytics/analytics-engine/limits/
 * @see https://developers.cloudflare.com/changelog/2025-06-20-increased-blob-size-limits-in-workers-analytics/
 */
const MAX_BLOB_BYTES = 16 * 1024;

/**
 * AE's documented per-data-point byte ceiling on the single `index`.
 * @see https://developers.cloudflare.com/analytics/analytics-engine/limits/
 */
const MAX_INDEX_BYTES = 96;

/** Shared encoder for measuring UTF-8 byte length (not string `.length`). */
const TEXT_ENCODER = new TextEncoder();

/** UTF-8 byte length of one positional AE value (string, ArrayBuffer, or null). */
const byteLengthOf = (value: ArrayBuffer | null | string): number => {
    if (value === null) {
        return 0;
    }

    if (typeof value === "string") {
        return TEXT_ENCODER.encode(value).length;
    }

    return value.byteLength;
};

/** Guard one positional array against AE's per-data-point cap; throws on overflow. */
const assertWithin = (kind: string, length: number, max: number): void => {
    if (length > max) {
        throw new RangeError(`@lunora/bindings/analytics: a data point may carry at most ${String(max)} ${kind} (got ${String(length)}).`);
    }
};

/** Guard a measured UTF-8 byte size against AE's per-data-point byte budget; throws on overflow. */
const assertByteBudget = (kind: string, bytes: number, max: number): void => {
    if (bytes > max) {
        throw new RangeError(`@lunora/bindings/analytics: a data point's ${kind} may total at most ${String(max)} bytes (got ${String(bytes)}).`);
    }
};

/**
 * Wrap an Analytics Engine dataset binding in the write-side
 * {@link AnalyticsClient} bound to `ctx.analytics`.
 *
 * The binding is `env.ANALYTICS` (the self-describing
 * `analytics_engine_datasets` binding the config layer reconciles). Writes are
 * fire-and-forget and sampled — there is no return value to read in-handler.
 *
 * `writeDataPoint` enforces AE's per-data-point caps eagerly — both the count
 * caps (≤20 blobs, ≤20 doubles, ≤1 index) and the byte budget (combined blobs
 * ≤16 KiB, index ≤96 bytes, measured as UTF-8) — so a misuse throws in dev
 * instead of being silently rejected by the platform at the edge. `track` is
 * the ergonomic named-field path: it maps a
 * `{ dimensions, metrics, index }` object to the positional layout and returns
 * the field→column mapping the read side uses to reconstruct named columns.
 */
// eslint-disable-next-line import/prefer-default-export -- re-exported as a named export from index.ts; the package convention is named-only exports
export const createAnalytics = (binding: AnalyticsEngineDatasetLike): AnalyticsClient => {
    const writeDataPoint = (event: AnalyticsEngineDataPoint): void => {
        assertWithin("blobs", event.blobs?.length ?? 0, MAX_BLOBS);
        assertWithin("doubles", event.doubles?.length ?? 0, MAX_DOUBLES);
        assertWithin("indexes", event.indexes?.length ?? 0, MAX_INDEXES);

        const blobBytes = (event.blobs ?? []).reduce<number>((total, blob) => total + byteLengthOf(blob), 0);

        assertByteBudget("blobs", blobBytes, MAX_BLOB_BYTES);

        for (const index of event.indexes ?? []) {
            assertByteBudget("index", byteLengthOf(index), MAX_INDEX_BYTES);
        }

        binding.writeDataPoint(event);
    };

    const track = (name: string, event: TrackEvent = {}): TrackSchema => {
        const dimensionEntries = Object.entries(event.dimensions ?? {});
        const metricEntries = Object.entries(event.metrics ?? {});

        // `blob1` is reserved for the logical event name so the read side can
        // filter one dataset by event without a separate index.
        const blobs: string[] = [name, ...dimensionEntries.map(([, value]) => value)];
        const doubles: number[] = metricEntries.map(([, value]) => value);
        const indexes: string[] = event.index === undefined ? [] : [event.index];

        writeDataPoint({ blobs, doubles, indexes });

        // Column positions are 1-based and `blob1` is the event name, so the
        // first dimension lands at `blob2`.
        const dimensions: TrackColumn[] = dimensionEntries.map(([field], offset) => {
            return { column: `blob${String(offset + 2)}`, field };
        });
        const metrics: TrackColumn[] = metricEntries.map(([field], offset) => {
            return { column: `double${String(offset + 1)}`, field };
        });
        // eslint-disable-next-line unicorn/no-null -- TrackSchema.index is the public `TrackColumn | null` contract: null is the documented "no sampling key" value
        const index: TrackColumn | null = event.index === undefined ? null : { column: "index1", field: "index" };

        return { dimensions, index, metrics, name };
    };

    return { track, writeDataPoint };
};
