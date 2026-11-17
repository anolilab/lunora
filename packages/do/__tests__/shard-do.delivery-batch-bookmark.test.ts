import type { TransactionHeadroomTracker } from "@lunora/shard-engine";
import { afterEach, describe, expect, it } from "vitest";

import { installDeliveryFence } from "../src/delivery-authorization";
import type { DispatchBookmark, QueryReadScope } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import { cleanupDatabases, gate, secret, setup } from "./_helpers/delivery-authorization";

class BookmarkBatchShard extends ShardDO {
    public readonly paused = { entered: gate(), release: gate() };
    public readonly calls: string[] = [];

    public override async handleRpc(
        functionPath: string,
        _args: Record<string, unknown>,
        _headroom?: TransactionHeadroomTracker,
        _scope?: QueryReadScope,
        bookmarks?: DispatchBookmark,
    ): Promise<unknown> {
        this.calls.push(functionPath);
        if (functionPath === "writes:pause") {
            this.paused.entered.resolve();
            await this.paused.release.promise;
        } else {
            Object.assign(bookmarks ?? {}, { value: `bookmark-${functionPath}` });
        }
        return functionPath;
    }
}

const runBatch = async (guarded: boolean, fenced: string[]) => {
    const test = setup();
    const env = { LUNORA_RELAY_SECRET: secret };
    const shard = new BookmarkBatchShard(
        test.state,
        env,
        guarded
            ? {
                  deliveryAuthorization: async ({ functionPath }) => {
                      return { scope: functionPath, epoch: 0 };
                  },
              }
            : {},
    );
    const paths = ["writes:first", "writes:second", "writes:pause"];
    const pending = shard.fetch(
        new Request("https://shard.internal/rpc-batch", {
            method: "POST",
            headers: { "x-lunora-userid": "alice" },
            body: JSON.stringify({
                calls: paths.map((functionPath, id) => {
                    return { id, functionPath, args: {} };
                }),
            }),
        }),
    );
    await shard.paused.entered.promise;
    try {
        await Promise.all(
            fenced.map((scope) =>
                installDeliveryFence(
                    { fetch: (url, init) => shard.fetch(new Request(url, init)) },
                    {
                        env,
                        shardKey: undefined,
                        fence: { scope, epoch: 1 },
                    },
                ),
            ),
        );
    } finally {
        shard.paused.release.resolve();
    }
    return { response: await pending, calls: shard.calls };
};

const cases = [
    {
        name: "keeps the earlier write bookmark when a later write is fenced",
        guarded: true,
        fenced: ["writes:second"],
        bookmark: "bookmark-writes:first",
        statuses: [200, 409, 200],
    },
    {
        name: "keeps the later write bookmark when an earlier write is fenced",
        guarded: true,
        fenced: ["writes:first"],
        bookmark: "bookmark-writes:second",
        statuses: [409, 200, 200],
    },
    { name: "drops bookmarks when every write is fenced", guarded: true, fenced: ["writes:first", "writes:second"], bookmark: null, statuses: [409, 409, 200] },
    {
        name: "keeps the latest write bookmark without delivery authorization",
        guarded: false,
        fenced: [],
        bookmark: "bookmark-writes:second",
        statuses: [200, 200, 200],
    },
];

describe("delivery-authorized batch bookmarks", () => {
    afterEach(cleanupDatabases);

    it.each(cases)("$name", async ({ guarded, fenced, bookmark, statuses }) => {
        expect.hasAssertions();

        const { response, calls } = await runBatch(guarded, fenced);

        expect(response.status).toBe(200);
        expect(response.headers.get("x-d1-bookmark")).toBe(bookmark);

        const body: { results: { body: unknown; id: number; status: number }[] } = await response.json();

        expect(body.results.map((entry) => entry.status)).toEqual(statuses);
        expect(calls).toEqual(["writes:first", "writes:second", "writes:pause"]);
        expect(body.results.map((entry) => entry.body)).toEqual(
            calls.map((path) =>
                fenced.includes(path) ? { error: { code: "DELIVERY_FENCED", message: "Delivery fenced; operation may have committed" } } : { result: path },
            ),
        );
    });
});
