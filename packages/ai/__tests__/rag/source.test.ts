import { describe, expect, it, vi } from "vitest";

import type { RagObjectSource, RagSourceObject } from "../../src/rag/source";
import { defineRagSource } from "../../src/rag/source";
import type { IndexResult, Rag, RemoveInput } from "../../src/rag/types";

/** A `Rag` double recording what it was asked to index and remove. */
const fakeRag = (): { indexed: Map<string, string>; rag: Rag; removed: string[] } => {
    const indexed = new Map<string, string>();
    const removed: string[] = [];

    return {
        indexed,
        rag: {
            asTool: () => {
                throw new Error("unused");
            },
            index: (input): Promise<IndexResult> => {
                const unchanged = indexed.get(input.id) === input.text;

                indexed.set(input.id, input.text);

                return Promise.resolve({ chunks: 1, ids: [`${input.id}#0`], unchanged });
            },
            remove: (input: RemoveInput): Promise<void> => {
                removed.push(input.id);
                indexed.delete(input.id);

                return Promise.resolve();
            },
            retrieve: () => {
                throw new Error("unused");
            },
        },
        removed,
    };
};

const source = (entries: Record<string, string>, overrides: Partial<RagSourceObject> = {}): RagObjectSource => {
    return {
        get: (object) => entries[object.key],
        list: () =>
            Object.keys(entries).map((key) => {
                return { key, ...overrides };
            }),
    };
};

describe("defineRagSource", () => {
    it("indexes every object in the source", async () => {
        expect.assertions(2);

        const { indexed, rag } = fakeRag();
        const report = await defineRagSource(rag).sync(source({ "a.txt": "alpha text", "b.txt": "bravo text" }));

        expect(report.indexed).toStrictEqual(["a.txt", "b.txt"]);
        expect(indexed.get("a.txt")).toBe("alpha text");
    });

    it("re-syncing unchanged content embeds nothing", async () => {
        expect.assertions(2);

        const { rag } = fakeRag();
        const ingest = defineRagSource(rag);
        const entries = { "a.txt": "alpha text" };

        await ingest.sync(source(entries));
        const second = await ingest.sync(source(entries));

        // The content-hash short-circuit is what makes a cron sync free.
        expect(second.unchanged).toStrictEqual(["a.txt"]);
        expect(second.indexed).toStrictEqual([]);
    });

    it("re-indexes an object whose content changed", async () => {
        expect.assertions(1);

        const { rag } = fakeRag();
        const ingest = defineRagSource(rag);

        await ingest.sync(source({ "a.txt": "original" }));
        const second = await ingest.sync(source({ "a.txt": "revised" }));

        expect(second.indexed).toStrictEqual(["a.txt"]);
    });

    it("prunes a known key that disappeared from the source", async () => {
        expect.assertions(2);

        const { rag, removed } = fakeRag();
        const ingest = defineRagSource(rag);

        const report = await ingest.sync(source({ "a.txt": "alpha" }), { knownKeys: ["a.txt", "b.txt"] });

        // A document deleted at the source but left indexed keeps being cited.
        expect(report.pruned).toStrictEqual(["b.txt"]);
        expect(removed).toStrictEqual(["b.txt"]);
    });

    it("prunes nothing without knownKeys, however many passes it has run", async () => {
        expect.assertions(3);

        const { rag, removed } = fakeRag();
        const ingest = defineRagSource(rag);

        const first = await ingest.sync(source({ "a.txt": "alpha", "b.txt": "bravo" }));
        const second = await ingest.sync(source({ "a.txt": "alpha" }));

        // No hidden per-instance memory of the previous pass: prune is the
        // caller's set or nothing, so the documented per-request shape cannot
        // silently prune (or silently fail to).
        expect(first.pruned).toStrictEqual([]);
        expect(second.pruned).toStrictEqual([]);
        expect(removed).toStrictEqual([]);
    });

    it("prunes nothing when every known key is still listed", async () => {
        expect.assertions(1);

        const { rag } = fakeRag();
        const report = await defineRagSource(rag).sync(source({ "a.txt": "alpha", "b.txt": "bravo" }), { knownKeys: ["a.txt"] });

        expect(report.pruned).toStrictEqual([]);
    });

    it("skips a content type with no extractor rather than indexing raw bytes", async () => {
        expect.assertions(2);

        const { indexed, rag } = fakeRag();
        const report = await defineRagSource(rag).sync(source({ "a.pdf": "%PDF-1.7 binary noise" }));

        // Indexing a PDF's bytes fills the index with something that embeds to
        // nothing meaningful.
        expect(report.skipped).toStrictEqual(["a.pdf"]);
        expect(indexed.size).toBe(0);
    });

    it("uses an extractor matched by content type", async () => {
        expect.assertions(2);

        const { indexed, rag } = fakeRag();
        // Split/join rather than a regex: the extractor's job here is only to prove
        // the hook is called, and a tag-stripping pattern is a backtracking hazard.
        const extract = vi.fn<(raw: string) => string>((raw) =>
            raw
                .split("<")
                .map((piece) => piece.slice(piece.indexOf(">") + 1))
                .join(""),
        );
        const report = await defineRagSource(rag, { extractors: { "text/html": extract } }).sync(source({ "page.html": "<h1>Title</h1><p>Body</p>" }));

        expect(report.indexed).toStrictEqual(["page.html"]);
        expect(indexed.get("page.html")).toBe("TitleBody");
    });

    it("falls back to a `*` extractor", async () => {
        expect.assertions(1);

        const { rag } = fakeRag();
        const report = await defineRagSource(rag, { extractors: { "*": (raw) => raw.toUpperCase() } }).sync(source({ "a.pdf": "text" }));

        expect(report.indexed).toStrictEqual(["a.pdf"]);
    });

    it("skips an object the source cannot read", async () => {
        expect.assertions(1);

        const { rag } = fakeRag();
        const report = await defineRagSource(rag).sync({ get: () => undefined, list: () => [{ key: "a.txt" }] });

        expect(report.skipped).toStrictEqual(["a.txt"]);
    });

    it("skips an extractor that produced only whitespace", async () => {
        expect.assertions(1);

        const { rag } = fakeRag();
        const report = await defineRagSource(rag, { extractors: { "*": () => "   " } }).sync(source({ "a.pdf": "x" }));

        expect(report.skipped).toStrictEqual(["a.pdf"]);
    });

    it("consumes an async iterable listing", async () => {
        expect.assertions(1);

        const { rag } = fakeRag();
        const report = await defineRagSource(rag).sync({
            get: () => "text",

            async* list() {
                yield { key: "a.txt" };
                yield { key: "b.txt" };
            },
        });

        expect(report.indexed).toStrictEqual(["a.txt", "b.txt"]);
    });

    it("threads namespace and metadata through to the index call", async () => {
        expect.assertions(2);

        const calls: { metadata?: Record<string, unknown>; namespace?: string }[] = [];
        const { rag } = fakeRag();
        const wrapped: Rag = {
            ...rag,
            index: (input) => {
                calls.push({ metadata: input.metadata, namespace: input.namespace });

                return rag.index(input);
            },
        };

        await defineRagSource(wrapped, { namespace: "org-1" }).sync(source({ "a.txt": "text" }, { metadata: { url: "/a" } }));

        expect(calls[0]?.namespace).toBe("org-1");
        expect(calls[0]?.metadata).toStrictEqual({ url: "/a" });
    });

    it("reports progress per object", async () => {
        expect.assertions(1);

        const seen: string[] = [];
        const { rag } = fakeRag();

        await defineRagSource(rag, {
            onObject: (info) => seen.push(`${info.key}:${info.status}`),
        }).sync(source({ "a.txt": "alpha", "b.pdf": "bytes" }));

        expect(seen.toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["a.txt:indexed", "b.pdf:skipped"]);
    });

    it("rejects a non-positive concurrency", () => {
        expect.assertions(1);

        const { rag } = fakeRag();

        expect(() => defineRagSource(rag, { concurrency: 0 })).toThrow(/`concurrency` must be a positive integer/u);
    });
});
