import { describe, expect, it } from "vitest";

import { afterBaseRowCommitted, isPostCommitError } from "../src/post-commit-error";

describe(isPostCommitError, () => {
    it("keeps every row that committed when overlapping writes throw one shared error", async () => {
        expect.assertions(3);

        // A trigger may throw a module-level error object, so two writes in flight can raise the same one.
        const shared = new Error("trigger failed");
        let releaseFirst: () => void = () => {};
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = afterBaseRowCommitted("notes", "a", async () => {
            await firstGate;

            throw shared;
        }).catch((error: unknown) => error);
        const second = await afterBaseRowCommitted("notes", "b", async () => {
            throw shared;
        }).catch((error: unknown) => error);

        releaseFirst();

        const firstError = await first;

        expect(isPostCommitError(second, "notes", "b")).toBe(true);
        expect(isPostCommitError(firstError, "notes", "a")).toBe(true);
        expect(isPostCommitError(firstError, "notes", "c")).toBe(false);
    });
});
