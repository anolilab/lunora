import { describe, expect, it } from "vitest";

import { afterBaseRowCommitted, takePostCommitError } from "../src/post-commit-error";

describe(takePostCommitError, () => {
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

        expect(takePostCommitError(second, "notes", "b")).toBe(true);
        expect(takePostCommitError(firstError, "notes", "a")).toBe(true);
        expect(takePostCommitError(firstError, "notes", "c")).toBe(false);
    });

    it("answers once per mark, so a reused error does not vouch for a later write of the same row", async () => {
        expect.assertions(2);

        const shared = new Error("trigger failed");
        const first = await afterBaseRowCommitted("notes", "x", async () => {
            throw shared;
        }).catch((error: unknown) => error);

        expect(takePostCommitError(first, "notes", "x")).toBe(true);
        // The same object thrown later by a write of "x" that failed BEFORE its row committed carries no new mark.
        expect(takePostCommitError(shared, "notes", "x")).toBe(false);
    });
});
