import { describe, expect, it } from "vitest";

import { ragSyncTriggers } from "../../src/rag/sync";

const ACTION = { __lunoraRef: "docs:reindex" };

/** Records what the trigger scheduled, standing in for `ctx.scheduler`. */
const fakeContext = () => {
    const scheduled: { args?: Record<string, unknown>; delayMs: number }[] = [];

    return {
        context: {
            scheduler: {
                runAfter: async (delayMs: number, _target: unknown, args?: Record<string, unknown>) => {
                    scheduled.push({ args, delayMs });

                    return "job-1";
                },
            },
        },
        scheduled,
    };
};

describe("ragSyncTriggers", () => {
    it("schedules a re-index for an inserted row", async () => {
        expect.assertions(1);

        const { context, scheduled } = fakeContext();
        const sync = ragSyncTriggers({ action: ACTION, text: (document) => document["body"] as string });

        await sync.afterInsert(context, { doc: { body: "hello" }, id: "doc-1" });

        expect(scheduled).toStrictEqual([{ args: { id: "doc-1", text: "hello" }, delayMs: 0 }]);
    });

    it("skips an update that did not touch the indexed text", async () => {
        expect.assertions(1);

        const { context, scheduled } = fakeContext();
        const sync = ragSyncTriggers({ action: ACTION, text: (document) => document["body"] as string });

        // A title-only edit: the embedding would be byte-identical, so the whole
        // dispatch is skipped rather than relying on the content-hash no-op.
        await sync.afterUpdate(context, { doc: { body: "hello", title: "new" }, id: "doc-1", previous: { body: "hello", title: "old" } });

        expect(scheduled).toStrictEqual([]);
    });

    it("removes the chunks when the indexed text goes away", async () => {
        expect.assertions(2);

        const { context, scheduled } = fakeContext();
        const sync = ragSyncTriggers({ action: ACTION, text: (document) => document["body"] as string | undefined });

        await sync.afterUpdate(context, { doc: { title: "kept" }, id: "doc-1", previous: { body: "hello" } });
        await sync.afterDelete(context, { id: "doc-2", previous: { body: "gone" } });

        expect(scheduled[0]?.args).toStrictEqual({ deleted: true, id: "doc-1" });
        expect(scheduled[1]?.args).toStrictEqual({ deleted: true, id: "doc-2" });
    });

    it("honours a custom source id and delay", async () => {
        expect.assertions(1);

        const { context, scheduled } = fakeContext();
        const sync = ragSyncTriggers({
            action: ACTION,
            delayMs: 500,
            id: (document) => `slug:${String(document["slug"])}`,
            text: (document) => document["body"] as string,
        });

        await sync.afterInsert(context, { doc: { body: "hi", slug: "intro" }, id: "row-9" });

        expect(scheduled).toStrictEqual([{ args: { id: "slug:intro", text: "hi" }, delayMs: 500 }]);
    });
});
