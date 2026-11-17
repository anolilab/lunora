import { describe, expect, it } from "vitest";

import type { CdcChange, DatabaseWriterLike } from "../src/ctx-db";
import { applyCdcChanges } from "../src/ctx-db-cdc";
import { ConflictError } from "../src/transaction";

/**
 * A row stored under a NUL-bearing id before the guard on explicit ids. `insert` refuses that id before it can
 * report a conflict, so a replayed update must rewrite the row in place, not fail the replay.
 */
const LEGACY_ID = "a\u0000x";

interface Calls {
    get: string[];
    insert: string[];
    replace: string[];
}

const fakeWriter = (existing: ReadonlySet<string>, refuseInsert: (id: string) => Error | undefined): { calls: Calls; writer: DatabaseWriterLike } => {
    const calls: Calls = { get: [], insert: [], replace: [] };

    const writer = {
        delete: () => Promise.resolve(),
        get: (_table: string, id: string) => {
            calls.get.push(id);

            return Promise.resolve(existing.has(id) ? { _id: id } : null);
        },
        insert: (_table: string, document: Record<string, unknown>) => {
            const id = String(document["_id"]);

            calls.insert.push(id);

            const refused = refuseInsert(id);

            if (refused !== undefined) {
                return Promise.reject(refused);
            }

            return Promise.resolve(id);
        },
        replace: (_table: string, id: string) => {
            calls.replace.push(id);

            return Promise.resolve();
        },
    };

    return { calls, writer: writer as never };
};

const update = (id: string): CdcChange => ({ doc: { _id: id, label: "after" }, id, op: "update", table: "items" }) as never;

describe("applyCdcChanges replays an update to a row stored under a NUL-bearing id", () => {
    it("rewrites the existing row in place, without an insert that the guard would refuse", async () => {
        expect.assertions(3);

        const { calls, writer } = fakeWriter(new Set([LEGACY_ID]), (id) => (id.includes("\u0000") ? new Error("guard: NUL in id") : undefined));

        await applyCdcChanges(writer, [update(LEGACY_ID)]);

        expect(calls.replace).toStrictEqual([LEGACY_ID]);
        expect(calls.insert).toStrictEqual([]);
        expect(calls.get).toStrictEqual([LEGACY_ID]);
    });

    it("still inserts a NUL-bearing id that does not exist, so the guard decides", async () => {
        expect.assertions(2);

        const { calls, writer } = fakeWriter(new Set(), (id) => (id.includes("\u0000") ? new Error("guard: NUL in id") : undefined));

        await expect(applyCdcChanges(writer, [update(LEGACY_ID)])).rejects.toThrow(/guard/u);
        expect(calls.replace).toStrictEqual([]);
    });

    it("keeps the conflict fallback for an ordinary id", async () => {
        expect.assertions(2);

        const { calls, writer } = fakeWriter(new Set(["m_1"]), () => new ConflictError());

        await applyCdcChanges(writer, [update("m_1")]);

        expect(calls.insert).toStrictEqual(["m_1"]);
        expect(calls.replace).toStrictEqual(["m_1"]);
    });
});
