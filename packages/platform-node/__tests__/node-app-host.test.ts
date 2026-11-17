import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeAppHost } from "../src/node-app-host";
import type { NodeShardState } from "../src/node-shard-state";

/** A Durable Object that counts in its shard's SQLite, so a count that survives a new host proves the database persisted. */
class Counter {
    private readonly env: Record<string, unknown>;

    private readonly state: NodeShardState;

    public constructor(state: NodeShardState, env: Record<string, unknown>) {
        this.state = state;
        this.env = env;
    }

    public async fetch(): Promise<Response> {
        const { sql } = this.state.storage;

        sql.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
        sql.exec("INSERT INTO hits (n) VALUES (1)");

        const [row] = sql.exec<{ count: number }>("SELECT count(*) AS count FROM hits").toArray();

        return Response.json({ count: row?.count, greeting: this.env["GREETING"], shard: this.state.id.name });
    }
}

const worker = {
    Counter,
    default: {
        fetch: async (request: Request, env: { COUNTER: { getByName: (name: string) => { fetch: (request: Request) => Promise<Response> } } }) =>
            env.COUNTER.getByName(new URL(request.url).pathname.slice(1)).fetch(request),
    },
};

describe(createNodeAppHost, () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-node-app-host-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("routes the worker's binding to the exported class, with env, and keeps shard data across hosts", async () => {
        expect.assertions(2);

        const options = { dataDirectory: directory, durableObjects: [{ className: "Counter", name: "COUNTER" }], env: { GREETING: "hi" }, worker };
        const first = createNodeAppHost(options);

        await first.fetch(new Request("https://app.local/tenant-a"));

        const response = await first.fetch(new Request("https://app.local/tenant-a"));

        await expect(response.json()).resolves.toStrictEqual({
            count: 2,
            greeting: "hi",
            shard: "tenant-a",
        });

        await first.close();

        const second = createNodeAppHost(options);

        try {
            const reopened = await second.fetch(new Request("https://app.local/tenant-a"));

            await expect(reopened.json()).resolves.toMatchObject({ count: 3 });
        } finally {
            await second.close();
        }
    });

    it("refuses a binding whose class the worker module does not export", () => {
        expect.assertions(1);

        expect(() => createNodeAppHost({ durableObjects: [{ className: "Missing", name: "COUNTER" }], worker })).toThrow(/names class Missing/);
    });
});
