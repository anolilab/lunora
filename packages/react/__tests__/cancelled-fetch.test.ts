import { CancelledError } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import isCancelledFetch from "../src/cancelled-fetch";

describe("isCancelledFetch", () => {
    it("recognises this copy's CancelledError", () => {
        expect.hasAssertions();

        expect(isCancelledFetch(new CancelledError({ revert: true }))).toBe(true);
    });

    it("recognises a CancelledError from another TanStack copy by its shape", () => {
        expect.hasAssertions();

        // Another copy's class: same name, same own fields, not an instance of this copy's class.
        const foreign = Object.assign(new Error("CancelledError"), { revert: undefined, silent: undefined });

        expect(foreign instanceof CancelledError).toBe(false);
        expect(isCancelledFetch(foreign)).toBe(true);
    });

    it("does not treat a real failure as a cancellation", () => {
        expect.hasAssertions();

        expect(isCancelledFetch(new Error("boom"))).toBe(false);
        expect(isCancelledFetch(null)).toBe(false);
    });
});
