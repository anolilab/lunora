import { describe, expect, it } from "vitest";

import { dedupScopeOf, isDedupScope, scheduledMutationId } from "../../../shared/scheduled-mutation-id";

// SHA-256 vectors computed with `node:crypto`, independently of the helper under test.
describe("shared/scheduled-mutation-id", () => {
    it("scopes a user id to the first 32 hex characters of its SHA-256", async () => {
        expect.assertions(3);

        await expect(dedupScopeOf("user-1")).resolves.toBe("c6c289e49e9c05b2145860387b73bcb1");
        await expect(dedupScopeOf("user-2")).resolves.toBe("d92b69cfb82cecab45c753f56002b2c0");
        expect(isDedupScope(await dedupScopeOf("user-1"))).toBe(true);
    });

    it("derives the mutation id from the function path, the scope and the key", async () => {
        expect.assertions(4);

        await expect(scheduledMutationId("notes:add", undefined, "job-1")).resolves.toBe("4d377f7886b7213f2ded06a3aaf991a6ac49896e017ed55c126ea07ff5fe9221");
        await expect(scheduledMutationId("notes:add", undefined, "sync-user-1700000000000")).resolves.toBe(
            "b80091bfc07dfe767ed4bb13b1867abec8b48b3974cacd29773468eaab6b4ea3",
        );
        await expect(scheduledMutationId("notes:add", "c6c289e49e9c05b2145860387b73bcb1", "sync-user-1700000000000")).resolves.toBe(
            "e026610c1c20b5a37102fc06f76d7251d7d48c3f16ef46c646a793116e4c4a25",
        );
        await expect(scheduledMutationId("notes:remove", undefined, "job-1")).resolves.not.toBe(
            "4d377f7886b7213f2ded06a3aaf991a6ac49896e017ed55c126ea07ff5fe9221",
        );
    });

    it("accepts only 32 lowercase hex characters as a scope", () => {
        expect.assertions(4);

        expect(isDedupScope("c6c289e49e9c05b2145860387b73bcb1")).toBe(true);
        expect(isDedupScope("C6C289E49E9C05B2145860387B73BCB1")).toBe(false);
        expect(isDedupScope("c6c289e49e9c05b2145860387b73bcb10")).toBe(false);
        expect(isDedupScope("user-1")).toBe(false);
    });
});
