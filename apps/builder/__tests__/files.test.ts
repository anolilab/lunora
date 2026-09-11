/**
 * The rules every file write has to satisfy — `lunora/file-limits.ts` — plus the
 * storage-level proof that `files.revision` really advances on each write.
 *
 * The size cases are the point: a `String.length` cap is not a byte cap, and the
 * strings below are exactly the ones that make the difference visible.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertRevision, assertWithinLimit, MAX_FILE_BYTES, utf8ByteLength } from "../lunora/file-limits";
import { editInternal, writeInternal } from "../lunora/files";
import schema from "../lunora/schema";

/** A registered function's handler, reachable from the harness's trusted `t.run` surface. */
type RegisteredHandler<R> = { handler: (context: unknown, args: unknown) => Promise<R> };

describe("utf8ByteLength", () => {
    it("counts bytes, not UTF-16 code units", () => {
        expect.assertions(3);

        expect(utf8ByteLength("abc")).toBe(3);
        // One code point, two UTF-16 units, four UTF-8 bytes.
        expect(utf8ByteLength("😀")).toBe(4);
        // One code unit, three bytes — the case a `.length` check silently
        // under-counts by a factor of three across a whole CJK source file.
        expect(utf8ByteLength("字")).toBe(3);
    });
});

describe("assertWithinLimit", () => {
    it("accepts content at the cap", () => {
        expect.assertions(1);

        expect(() => {
            assertWithinLimit("src/a.ts", "a".repeat(MAX_FILE_BYTES));
        }).not.toThrow();
    });

    it("rejects content whose BYTE length is over the cap even though its code-unit length is not", () => {
        expect.assertions(2);

        // Two-thirds of the cap in code units, but three bytes each — so
        // `content.length <= MAX_FILE_BYTES` is true and the file is 2× the cap.
        const content = "字".repeat(Math.floor((MAX_FILE_BYTES * 2) / 3));

        expect(content.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
        expect(() => {
            assertWithinLimit("src/a.ts", content);
        }).toThrow(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
    });
});

describe("assertRevision", () => {
    it("allows a write that claims no revision", () => {
        expect.assertions(1);

        // The agent's own tools read and write inside one durable step, so they
        // have nothing to race and send no expectation.
        expect(() => {
            assertRevision("src/a.ts", 7, undefined);
        }).not.toThrow();
    });

    it("allows a write whose expectation matches", () => {
        expect.assertions(1);

        expect(() => {
            assertRevision("src/a.ts", 7, 7);
        }).not.toThrow();
    });

    it("rejects a save against a file that moved", () => {
        expect.assertions(1);

        expect(() => {
            assertRevision("src/a.ts", 8, 7);
        }).toThrow(expect.objectContaining({ code: "CONFLICT" }));
    });
});

describe("file writes against the real schema", () => {
    let t: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        t = lunoraTest(schema);
    });

    afterEach(() => {
        t.close();
    });

    /**
     * The agent's write tool, dispatched through `t.run`.
     *
     * `t.mutation` refuses an `internalMutation` on purpose — it models the
     * external RPC boundary, where these are unreachable. `t.run` is the
     * harness's trusted server-dispatch surface, which is where the durable
     * agent loop calls from.
     */
    const write = async (content: string, path = "src/a.ts"): Promise<{ created: boolean; revision: number }> =>
        t.run(async (ctx) =>
            (writeInternal as unknown as RegisteredHandler<{ created: boolean; revision: number }>).handler(ctx, { content, path, projectId: "p1" }),
        );

    it("advances the revision on every write, so a stale save is detectable", async () => {
        expect.assertions(3);

        await expect(write("one")).resolves.toStrictEqual({ created: true, path: "src/a.ts", revision: 1 });
        await expect(write("two")).resolves.toStrictEqual({ created: false, path: "src/a.ts", revision: 2 });
        await expect(write("three")).resolves.toStrictEqual({ created: false, path: "src/a.ts", revision: 3 });
    });

    it("keeps revisions per file rather than per project", async () => {
        expect.assertions(2);

        await write("one", "src/a.ts");

        const created = await write("one", "src/b.ts");
        const updated = await write("two", "src/a.ts");

        expect(created.revision).toBe(1);
        expect(updated.revision).toBe(2);
    });

    it("rejects an edit whose RESULT is over the byte cap", async () => {
        expect.assertions(1);

        await write("marker");

        // A six-character anchor swapped for an oversized body: the patch is
        // tiny, the resulting file is not, and checking only the arguments
        // would let this through.
        await expect(
            t.run(async (ctx) =>
                (editInternal as unknown as RegisteredHandler<unknown>).handler(ctx, {
                    find: "marker",
                    path: "src/a.ts",
                    projectId: "p1",
                    replace: "字".repeat(MAX_FILE_BYTES),
                }),
            ),
        ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    });
});
