/**
 * Bulk ingestion: point a RAG index at a store of documents and keep it in
 * step.
 *
 * `rag.index()` takes one document's text, which leaves the whole crawl — list
 * the objects, fetch each, extract text, index it, notice the ones that were
 * deleted — as something every app writes for itself. This is the one axis on
 * which Cloudflare's managed AutoRAG pipeline is genuinely more convenient than
 * `defineRag`.
 *
 * The object source is **injected**, so this works over an R2 bucket, S3, a
 * filesystem, or a database table without `@lunora/ai` depending on any of
 * them. Extractors are injected for the same reason: parsing PDF is a large
 * dependency, and a package that pulls one in for everybody to serve the users
 * who need it has made the wrong trade.
 *
 * Re-syncing is cheap by construction. `rag.index` short-circuits on a content
 * hash, so an unchanged object costs one `get` and no embedding at all — which
 * makes running this on a cron the normal way to use it.
 * @experimental
 */
import { LunoraError } from "@lunora/errors";

import { concurrentMap } from "./concurrent";
import { guessMimeTypeFromExtension } from "./helpers";
import type { Rag } from "./types";

/** One object listed by a {@link RagObjectSource}. */
interface RagSourceObject {
    /** Content type, when the source knows it. Falls back to the key's extension. */
    contentType?: string;
    /** Stable key — becomes the indexed source id. */
    key: string;
    /** Metadata attached to every chunk of this object. */
    metadata?: Record<string, unknown>;
}

/**
 * Where documents come from. Two operations, both injected.
 *
 * `list` is an async iterable rather than an array so a bucket with a million
 * keys can be paged through without materialising every key first — the caller
 * decides how to page, this only consumes.
 */
interface RagObjectSource {
    /** Fetch one object's raw text. Return `undefined` to skip it (unreadable, unsupported). */
    get: (object: RagSourceObject) => Promise<string | undefined> | string | undefined;
    /** Enumerate the objects to index. */
    list: () => AsyncIterable<RagSourceObject> | Iterable<RagSourceObject>;
}

/** Turn a fetched object's raw text into indexable plain text. */
type RagExtractor = (raw: string, object: RagSourceObject) => Promise<string | undefined> | string | undefined;

/** Options for {@link defineRagSource}. */
interface RagSourceOptions {
    /**
     * How many objects to process at once. Default 4.
     *
     * Each one is a fetch plus an embed plus an upsert, so this multiplies into
     * the subrequest budget — the default is deliberately low.
     */
    concurrency?: number;

    /**
     * Extractors keyed by content type (`text/html`, `application/pdf`, …), or
     * `"*"` as a fallback. A content type with no extractor and no `"*"` entry
     * is skipped and counted in `skipped` — never indexed as raw bytes, which
     * would fill the index with markup or binary noise that embeds to nothing
     * meaningful.
     */
    extractors?: Record<string, RagExtractor>;

    /** Namespace (tenant/shard key) applied to every indexed object. */
    namespace?: string;

    /** Called after each object is handled — for progress reporting. */
    onObject?: (info: { chunks: number; key: string; status: "indexed" | "skipped" | "unchanged" }) => void;

    /**
     * Delete indexed sources whose key no longer appears in `list()`.
     * Default `true`.
     *
     * This is what makes the index a mirror rather than an append-only pile: a
     * document removed at the source but left in the index keeps being
     * retrieved and cited, which is worse than never having indexed it.
     */
    prune?: boolean;
}

/** What one {@link RagSourceSync.sync} pass did. */
interface RagSyncReport {
    /** Keys indexed for the first time or re-indexed after a change. */
    indexed: string[];
    /** Keys deleted from the index because they no longer exist at the source. */
    pruned: string[];
    /** Keys skipped — no extractor, or the source returned nothing. */
    skipped: string[];
    /** Keys whose content hash matched, so nothing was embedded. */
    unchanged: string[];
}

/** The bound ingestion surface. */
interface RagSourceSync {
    /** Run one full pass over the source. */
    sync: (source: RagObjectSource) => Promise<RagSyncReport>;
}

const DEFAULT_CONCURRENCY = 4;

/** Stable key ordering for a report — objects are processed concurrently, so arrival order is not meaningful. */
const byKey = (left: string, right: string): number => left.localeCompare(right);

/** Resolve the extractor for an object, or `undefined` when none applies. */
const extractorFor = (object: RagSourceObject, extractors: Record<string, RagExtractor> | undefined): RagExtractor | undefined => {
    if (!extractors) {
        return undefined;
    }

    const contentType = (object.contentType ?? guessMimeTypeFromExtension(object.key.slice(object.key.lastIndexOf(".")))).split(";")[0]?.trim() ?? "";

    if (Object.hasOwn(extractors, contentType)) {
        return extractors[contentType];
    }

    return Object.hasOwn(extractors, "*") ? extractors["*"] : undefined;
};

/**
 * Text types that need no extractor. Anything else without one is skipped
 * rather than indexed raw — a PDF's bytes or an HTML file's markup embed to
 * something that matches nothing.
 */
const PLAIN_TEXT_TYPES = new Set(["application/json", "text/csv", "text/markdown", "text/plain"]);

/**
 * Declare a bulk-ingestion pass over a {@link Rag}.
 *
 * ```ts
 * const ingest = defineRagSource(docs(ctx), { namespace: ctx.shardKey });
 *
 * const report = await ingest.sync({
 *     list: async function* () {
 *         for await (const object of bucket.list()) {
 *             yield { key: object.key, metadata: { url: object.key } };
 *         }
 *     },
 *     get: async (object) => (await bucket.get(object.key))?.text(),
 * });
 * ```
 * @experimental
 */
const defineRagSource = (rag: Rag, options: RagSourceOptions = {}): RagSourceSync => {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new LunoraError("BAD_REQUEST", "@lunora/ai/rag: `concurrency` must be a positive integer");
    }

    /**
     * Keys seen in the previous pass, so the next one knows what disappeared.
     *
     * In-memory and therefore per-isolate: a first pass after a restart has
     * nothing to compare against and prunes nothing, rather than deleting an
     * index it has no record of. That is the safe direction — a stale entry is
     * recoverable, a wrongly-pruned one costs a full re-embed.
     */
    let previousKeys: ReadonlySet<string> | undefined;

    const sync = async (source: RagObjectSource): Promise<RagSyncReport> => {
        const objects: RagSourceObject[] = [];

        for await (const object of source.list()) {
            objects.push(object);
        }

        const report: RagSyncReport = { indexed: [], pruned: [], skipped: [], unchanged: [] };

        await concurrentMap(objects, concurrency, async (object) => {
            const raw = await source.get(object);

            if (raw === undefined) {
                report.skipped.push(object.key);
                options.onObject?.({ chunks: 0, key: object.key, status: "skipped" });

                return;
            }

            const extractor = extractorFor(object, options.extractors);
            const contentType = (object.contentType ?? guessMimeTypeFromExtension(object.key.slice(object.key.lastIndexOf(".")))).split(";")[0]?.trim() ?? "";
            let text: string | undefined;

            if (extractor) {
                text = await extractor(raw, object);
            } else if (PLAIN_TEXT_TYPES.has(contentType)) {
                text = raw;
            }

            if (text === undefined || text.trim().length === 0) {
                report.skipped.push(object.key);
                options.onObject?.({ chunks: 0, key: object.key, status: "skipped" });

                return;
            }

            const result = await rag.index({
                id: object.key,
                text,
                ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
                ...(object.metadata === undefined ? {} : { metadata: object.metadata }),
            });

            if (result.unchanged) {
                report.unchanged.push(object.key);
            } else {
                report.indexed.push(object.key);
            }

            options.onObject?.({ chunks: result.chunks, key: object.key, status: result.unchanged ? "unchanged" : "indexed" });
        });

        const currentKeys = new Set(objects.map((object) => object.key));

        // Prune only against a set this instance actually observed. Deleting
        // everything absent from the first pass would wipe an index built by a
        // previous isolate.
        if (options.prune !== false && previousKeys !== undefined) {
            const gone = [...previousKeys].filter((key) => !currentKeys.has(key));

            await concurrentMap(gone, concurrency, async (key) => {
                await rag.remove({ id: key, ...(options.namespace === undefined ? {} : { namespace: options.namespace }) });
                report.pruned.push(key);
            });
        }

        previousKeys = currentKeys;

        // Sorted so a report is comparable across runs — the objects were
        // processed concurrently, so arrival order is not meaningful.
        return {
            indexed: report.indexed.toSorted(byKey),
            pruned: report.pruned.toSorted(byKey),
            skipped: report.skipped.toSorted(byKey),
            unchanged: report.unchanged.toSorted(byKey),
        };
    };

    return { sync };
};

export type { RagExtractor, RagObjectSource, RagSourceObject, RagSourceOptions, RagSourceSync, RagSyncReport };
export default defineRagSource;
