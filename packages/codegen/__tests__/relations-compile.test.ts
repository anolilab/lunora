import { describe, expect, test } from "vitest";

import type { Doc_attachments, Doc_users, LoadWith } from "./fixtures/simple/expected/_generated/dataModel.js";

/**
 * Compile-fixture: the assertions below are verified by `tsc` (via `lint:types`),
 * not at runtime. Each typed local fails to compile unless `LoadWith` narrows the
 * returned document to exactly the relations requested in the `with` argument.
 * The runtime bodies operate on `{}` casts and merely keep vitest happy.
 */
describe("loadWith narrowing", () => {
    test("a requested `one` relation surfaces as `Doc | null`", () => {
        expect.assertions(1);

        const loaded = {} as LoadWith<"attachments", { owner: true }>;
        // Annotated destructuring asserts `owner` exists as `Doc_users | null`.
        const { owner }: { owner: Doc_users | null } = loaded;

        expect(owner).toBeUndefined();
    });

    test("an unrequested relation is absent — the result narrows to the bare Doc", () => {
        expect.assertions(1);

        const bare = {} as LoadWith<"attachments", {}>;

        // @ts-expect-error `owner` only exists when requested via `with`.
        bare.owner;

        expect(bare).toEqual({});
    });

    test("a requested `many` relation surfaces as `Doc[]`", () => {
        expect.assertions(1);

        const loaded = {} as LoadWith<"users", { attachments: true }>;
        // Annotated destructuring asserts `attachments` exists as `Doc_attachments[]`.
        const { attachments }: { attachments: Doc_attachments[] } = loaded;

        expect(attachments).toBeUndefined();
    });

    test("a nested `with` recurses, narrowing the related Doc too", () => {
        expect.assertions(1);

        const loaded = { attachments: [{ owner: null }] } as unknown as LoadWith<"users", { attachments: { with: { owner: true } } }>;
        const nestedOwner: Doc_users | null = loaded.attachments[0]!.owner;

        expect(nestedOwner).toBeNull();
    });

    test("`_count` projects each requested relation to a number", () => {
        expect.assertions(1);

        const loaded = { _count: { attachments: 0 } } as unknown as LoadWith<"users", { _count: { attachments: true } }>;
        const count: number = loaded._count.attachments;

        expect(count).toBe(0);
    });
});
