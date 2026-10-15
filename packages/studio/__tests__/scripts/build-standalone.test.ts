import { describe, expect, it } from "vitest";

import needsDevJsxRuntime from "../../scripts/needs-dev-jsx-runtime.mjs";

/** Module paths as an esbuild metafile lists them. */
const REACT_DEV_RUNTIME = "../../node_modules/.pnpm/react@19.2.8/node_modules/react/cjs/react-jsx-dev-runtime.production.js";
const HAST_TO_JSX = "../../node_modules/.pnpm/hast-util-to-jsx-runtime@2.3.6/node_modules/hast-util-to-jsx-runtime/lib/index.js";

describe("needsDevJsxRuntime", () => {
    it("is a hazard when React's dev JSX runtime is in the graph", () => {
        expect.assertions(1);

        // Nothing can call `jsxDEV` without importing this, and importing it is
        // precisely what breaks under production React — which exports
        // `jsxDEV = void 0` from it.
        expect(needsDevJsxRuntime(["src/mount.js", REACT_DEV_RUNTIME])).toBe(true);
    });

    it("is not a hazard when a dep merely MENTIONS jsxDEV", () => {
        expect.assertions(1);

        /*
         * The bug this replaced. `hast-util-to-jsx-runtime` — pulled in by anything
         * that renders markdown — guards `typeof options.jsxDEV !== "function"` on a
         * branch it only takes when asked for `development: true`. Grepping bundle
         * text for `jsxDEV` called that a hazard, so the standalone bundle shipped
         * development React to the static hosts and could never go back.
         */
        expect(needsDevJsxRuntime(["src/mount.js", HAST_TO_JSX])).toBe(false);
    });

    it("is not a hazard for an ordinary graph", () => {
        expect.assertions(1);

        expect(needsDevJsxRuntime(["src/mount.js", "../../node_modules/react/index.js"])).toBe(false);
    });
});
