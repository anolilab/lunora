import type { LoadWith as LoadWithOf } from "@lunora/server/data-model";
import { describe, expect, it } from "vitest";

import type {
    DataModel,
    Doc_attachments as Document_attachments,
    Doc_users as Document_users,
    Relations,
} from "./fixtures/simple/expected/_generated/dataModel";

/**
 * `LoadWith` is bound here exactly as the generated `server.ts` binds it.
 *
 * It is not imported from the fixture's `server.ts` because that file pulls in
 * whichever optional add-ons the fixture app uses (`@lunora/notify`, …), none of
 * which this package installs — which is the same coupling that made
 * `dataModel.ts` unusable from a consumer, now demonstrated from the inside.
 */
type LoadWith<T extends keyof DataModel, W> = LoadWithOf<DataModel, Relations, T, W>;

/**
 * Compile-fixture: the assertions below are verified by `tsc` (via `lint:types`),
 * not at runtime. Each typed local fails to compile unless `LoadWith` narrows the
 * returned document to exactly the relations requested in the `with` argument.
 * The runtime bodies operate on `{}` casts and merely keep vitest happy.
 */
describe("loadWith narrowing", () => {
    it("a requested `one` relation surfaces as `Doc | null`", () => {
        expect.assertions(1);

        const loaded = {} as LoadWith<"attachments", { owner: true }>;
        // Annotated destructuring asserts `owner` exists as `Doc_users | null`.
        const { owner }: { owner: Document_users | null } = loaded;

        expect(owner).toBeUndefined();
    });

    it("an unrequested relation is absent — the result narrows to the bare Doc", () => {
        expect.assertions(1);

        const bare = {} as LoadWith<"attachments", Record<string, never>>;

        // @ts-expect-error `owner` only exists when requested via `with`.
        bare.owner;

        expect(bare).toEqual({});
    });

    it("a requested `many` relation surfaces as `Doc[]`", () => {
        expect.assertions(1);

        const loaded = {} as LoadWith<"users", { attachments: true }>;
        // Annotated destructuring asserts `attachments` exists as `Doc_attachments[]`.
        const { attachments }: { attachments: Document_attachments[] } = loaded;

        expect(attachments).toBeUndefined();
    });

    it("a nested `with` recurses, narrowing the related Doc too", () => {
        expect.assertions(1);

        const loaded = { attachments: [{ owner: null }] } as unknown as LoadWith<"users", { attachments: { with: { owner: true } } }>;
        const nestedOwner: Document_users | null = loaded.attachments[0]!.owner;

        expect(nestedOwner).toBeNull();
    });

    it("`_count` projects each requested relation to a number", () => {
        expect.assertions(1);

        const loaded = { _count: { attachments: 0 } } as unknown as LoadWith<"users", { _count: { attachments: true } }>;
        const count: number = loaded._count.attachments;

        expect(count).toBe(0);
    });
});
