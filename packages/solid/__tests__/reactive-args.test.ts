import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackedArgsEffect } from "../src/reactive-args";

describe(trackedArgsEffect, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("does not read the args accessor when there is no browser global (SSR)", () => {
        vi.stubGlobal("window", undefined);

        const resolveArgs = vi.fn<() => never>(() => {
            throw new Error("window.location is not available on the server");
        });
        const apply = vi.fn<() => void>();

        createRoot((dispose) => {
            expect(() => {
                trackedArgsEffect(resolveArgs, apply);
            }).not.toThrow();

            dispose();
        });

        expect(resolveArgs).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });
});
