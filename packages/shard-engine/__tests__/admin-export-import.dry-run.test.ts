import { describe, expect, it, vi } from "vitest";

import { importShardRows, parseImportShardArgs } from "../src/admin-export-import";
import type { DatabaseWriterLike, SchemaLike } from "../src/schema-types";

const schema: SchemaLike = {
    tables: {
        events: {
            indexes: [],
            shape: { kind: { kind: "string" } },
        },
    },
};

/** A writer that records every insert and refuses nothing; the dry run must never reach it. */
const recordingWriter = (): { insert: ReturnType<typeof vi.fn>; writer: DatabaseWriterLike } => {
    const insert = vi.fn<() => Promise<undefined>>(async () => undefined);

    return { insert, writer: { insert } as unknown as DatabaseWriterLike };
};

describe("shard admin import — dry run", () => {
    it("reports the shape error in the last row and writes no row", async () => {
        expect.assertions(3);

        const { insert, writer } = recordingWriter();
        const rows = [
            { doc: { kind: "a" }, table: "events" },
            { doc: { kind: "b" }, table: "events" },
            { doc: { kind: "c", title: "undeclared" }, table: "events" },
        ];

        const result = await importShardRows(writer, schema, { dryRun: true, rows, startLine: 1 });

        expect(result.errors).toStrictEqual([
            { code: "VALIDATION_ERROR", line: 3, message: 'unexpected field "title": not declared in table "events"', table: "events" },
        ]);
        expect(insert).toHaveBeenCalledTimes(0);
        expect(result.inserted).toStrictEqual({});
    });

    it("writes the good rows and refuses the bad one when the dry run is off, which is the partial write a dry run prevents", async () => {
        expect.assertions(2);

        const { insert, writer } = recordingWriter();
        const rows = [
            { doc: { kind: "a" }, table: "events" },
            { doc: { kind: "c", title: "undeclared" }, table: "events" },
        ];

        const result = await importShardRows(writer, schema, { rows, startLine: 1 });

        expect(insert).toHaveBeenCalledTimes(1);
        expect(result.inserted).toStrictEqual({ events: 1 });
    });

    it("reads the dryRun flag, and is off unless the caller asks for it", () => {
        expect.assertions(2);

        expect(parseImportShardArgs({ dryRun: true, rows: [] }).dryRun).toBe(true);
        expect(parseImportShardArgs({ rows: [] }).dryRun).toBe(false);
    });
});
