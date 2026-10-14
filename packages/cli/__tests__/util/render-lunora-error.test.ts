import { LunoraError } from "@lunora/errors";
import { isVisulimaError, renderError } from "@visulima/error";
import { describe, expect, it } from "vitest";

import { renderLunoraError } from "../../src/util/render-lunora-error";

describe("renderLunoraError", () => {
    it("renders the message and the code's catalog hint", () => {
        expect.hasAssertions();

        const out = renderLunoraError(new LunoraError("CONFLICT", "boom"));

        expect(out).toContain("boom");
        // The CONFLICT catalog hint (flattened) is rendered underneath.
        expect(out).toContain("optimistic concurrency conflict");
    });

    it("tags the failure with a reason", () => {
        expect.hasAssertions();

        expect(renderLunoraError(new Error("nope"), { reason: "codegen failed" })).toContain("codegen failed: nope");
    });
});

/**
 * Contract test for the `@visulima/error` masquerade: `LunoraError` does NOT
 * extend `VisulimaError` (to stay zero-dependency + bundle-safe), it mirrors the
 * shape via `type = "VisulimaError"`. This pins that the renderer still
 * recognizes and renders it — if `@visulima/error` renames its discriminator or
 * hint/loc fields on an alpha bump, this goes red instead of silently dropping
 * hints in the CLI/overlay.
 */
describe("@visulima/error masquerade contract", () => {
    it("a raw LunoraError is recognized as a VisulimaError", () => {
        expect.hasAssertions();

        expect(isVisulimaError(new LunoraError("NOT_FOUND", "missing"))).toBe(true);
    });

    it("@visulima/error's renderError surfaces a raw LunoraError's message + hint", () => {
        expect.hasAssertions();

        const out = renderError(new LunoraError("RLS_REQUIRED", "denied"), { filterStacktrace: () => false });

        expect(out).toContain("denied");
        // The RLS_REQUIRED catalog hint is carried on `error.hint` and rendered.
        expect(out).toContain("secure-by-default");
    });
});
