import { describe, expect, it } from "vitest";

import stripKnownBundledJsxDev from "../../scripts/known-bundled-jsx-dev.mjs";

/*
 * Minified text as the production standalone bundle carries it: the markdown
 * renderer's `development` guard, copied verbatim from `dist/standalone`.
 */
const HAST_OPTIONS_GUARD = 'if(typeof t.jsxDEV!="function")throw new TypeError("Expected `jsxDEV` in options when `development: true`");n=b2(r,t.jsxDEV)';

/* A real React dev factory call, as esbuild emits it for a `jsxDEV` import. */
const REACT_DEV_FACTORY_CALL = '(0,p.jsxDEV)("label",{"data-slot":"label"},void 0,!1)';

describe("the known bundled jsxDEV block", () => {
    it("removes the markdown renderer's options guard, leaving no jsxDEV text", () => {
        expect.assertions(1);

        expect(stripKnownBundledJsxDev(HAST_OPTIONS_GUARD)).not.toContain("jsxDEV");
    });

    it("keeps a React dev factory call that sits beside the guard", () => {
        expect.assertions(1);

        // Removing the guard must not take a neighbouring real call with it.
        expect(stripKnownBundledJsxDev(`${HAST_OPTIONS_GUARD};return${REACT_DEV_FACTORY_CALL}`)).toContain("jsxDEV");
    });

    it("keeps a React dev factory call on its own", () => {
        expect.assertions(1);

        expect(stripKnownBundledJsxDev(`return${REACT_DEV_FACTORY_CALL}`)).toContain("jsxDEV");
    });

    it("keeps a guard whose checked factory differs from the one it passes", () => {
        expect.assertions(1);

        // The backreference is what makes this a single pattern rather than a
        // loose "guard plus pass-through" pair that any two identifiers satisfy.
        const mismatched = 'if(typeof t.jsxDEV!="function")throw new TypeError("Expected `jsxDEV` in options when `development: true`");n=b2(r,x.jsxDEV)';

        expect(stripKnownBundledJsxDev(mismatched)).toContain("jsxDEV");
    });
});
