/**
 * Runtime infrastructure for the mask/shape fail-closed check (plan 208,
 * Phase 1). A `defineShape` replicates a table partition to a client but runs
 * NO procedure, so `.use(mask(...))` never fires for it — without a guard, a
 * shape over a table any procedure masks would replicate the masked column's
 * raw value to every subscribed client. The actual fail-closed check runs at
 * `@lunora/codegen` build time (static discovery — see
 * `packages/codegen/src/run-codegen.ts`'s `assertNoMaskedShapeTable`), not at
 * runtime; these tests pin the runtime tag + registry infrastructure the
 * builder hoists (`fn.maskedTables`) — parity with RLS's `buildRlsReadRegistry`
 * and the substrate Phase 2 (masking shape rows) will build on.
 */
import { describe, expect, it } from "vitest";

import { buildMaskRegistry, initLunora, mask } from "../src/index";
import { readMaskTag } from "../src/mask/policy-tag";

const builders = initLunora.dataModel<unknown>().create();

/** A registered query carrying the given mask policies on `fn.maskedTables`. */
const maskedQuery = (policies: Parameters<typeof mask>[0], options?: Parameters<typeof mask>[1]) =>
    (builders.query as unknown as { use: (m: unknown) => { query: (h: () => unknown) => unknown } }).use(mask(policies, options)).query(() => null);

/** Flatten a `MaskTag`/registry's `Map&lt;table, Set&lt;column>>` into a plain, order-independent object for assertions. */
const toPlainObject = (columns: ReadonlyMap<string, ReadonlySet<string>>): Record<string, string[]> =>
    Object.fromEntries([...columns.entries()].map(([table, cols]) => [table, [...cols].toSorted((a, b) => a.localeCompare(b))]));

describe("readMaskTag", () => {
    it("returns the declared table→column names carried by a mask() middleware", () => {
        expect.assertions(1);

        const tag = readMaskTag(mask({ users: { ssn: "redact" } }));

        expect(toPlainObject(tag!.columns)).toStrictEqual({ users: ["ssn"] });
    });

    it("carries every declared column across several tables as plain names, never the strategies", () => {
        expect.assertions(2);

        const tag = readMaskTag(
            mask({
                posts: { body: (value) => value },
                users: { email: "redact", phone: "hash" },
            }),
        );

        expect(toPlainObject(tag!.columns)).toStrictEqual({ posts: ["body"], users: ["email", "phone"] });
        // Only column NAMES are tagged — every recorded entry is a string, never
        // the strategy closure/literal that declared it.
        expect([...tag!.columns.values()].every((columns) => [...columns].every((column) => typeof column === "string"))).toBe(true);
    });

    it("returns undefined for a middleware that never called mask()", () => {
        expect.assertions(1);

        expect(readMaskTag(async ({ next }: { next: () => unknown }) => next())).toBeUndefined();
    });
});

describe("fn.maskedTables (builder hoist)", () => {
    it("hoists a procedure's masked columns onto fn.maskedTables, grouped by table", () => {
        expect.assertions(2);

        const fn = maskedQuery({ users: { ssn: "redact" } });

        expect((fn as { maskedTables?: unknown }).maskedTables).toBeDefined();

        const { maskedTables } = fn as { maskedTables?: ReadonlyMap<string, ReadonlySet<string>> };

        expect(toPlainObject(maskedTables!)).toStrictEqual({ users: ["ssn"] });
    });

    it("carries no maskedTables key for a procedure with no mask() middleware", () => {
        expect.assertions(1);

        const fn = (builders.query as unknown as { query: (h: () => unknown) => unknown }).query(() => null);

        expect((fn as { maskedTables?: unknown }).maskedTables).toBeUndefined();
    });
});

describe("buildMaskRegistry", () => {
    it("unions two functions masking different columns of the same table", () => {
        expect.assertions(1);

        const first = maskedQuery({ users: { ssn: "redact" } });
        const second = maskedQuery({ users: { email: "hash" } });

        const registry = buildMaskRegistry([first, second]);

        expect(toPlainObject(registry)).toStrictEqual({ users: ["email", "ssn"] });
    });

    it("keeps tables separate and ignores non-masking functions", () => {
        expect.assertions(1);

        const usersMask = maskedQuery({ users: { ssn: "redact" } });
        const postsMask = maskedQuery({ posts: { body: "redact" } });
        const bare = (builders.query as unknown as { query: (h: () => unknown) => unknown }).query(() => null);

        const registry = buildMaskRegistry([usersMask, postsMask, bare]);

        expect(toPlainObject(registry)).toStrictEqual({ posts: ["body"], users: ["ssn"] });
    });

    it("returns an empty registry for a project with no mask() usage", () => {
        expect.assertions(1);

        const bare = (builders.query as unknown as { query: (h: () => unknown) => unknown }).query(() => null);

        expect(buildMaskRegistry([bare]).size).toBe(0);
    });
});
