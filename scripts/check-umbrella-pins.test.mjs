import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findUmbrellaPinDrift } from "./check-umbrella-pins.mjs";

const versions = { "@lunora/errors": "1.0.0-alpha.52", "@lunora/server": "1.0.0-alpha.187" };

describe("findUmbrellaPinDrift", () => {
    it("reports an exact pin behind the published version", () => {
        const drift = findUmbrellaPinDrift({ dependencies: { "@lunora/server": "1.0.0-alpha.185" } }, versions);

        assert.deepEqual(drift, [{ current: "1.0.0-alpha.187", name: "@lunora/server", pinned: "1.0.0-alpha.185" }]);
    });

    it("accepts an exact pin on the published version", () => {
        assert.deepEqual(findUmbrellaPinDrift({ dependencies: { "@lunora/server": "1.0.0-alpha.187" } }, versions), []);
    });

    it("accepts a range the published version satisfies, and reports one it does not", () => {
        assert.deepEqual(findUmbrellaPinDrift({ dependencies: { "@lunora/errors": ">=1.0.0-alpha.51 <2.0.0-0" } }, versions), []);
        assert.equal(findUmbrellaPinDrift({ dependencies: { "@lunora/errors": ">=1.0.0-alpha.60 <2.0.0-0" } }, versions).length, 1);
    });

    it("ignores workspace specifiers, non-sibling dependencies and unknown packages", () => {
        const umbrella = {
            dependencies: { "@lunora/server": "workspace:*", "@lunora/unknown": "1.0.0-alpha.1", zod: "3.25.76" },
        };

        assert.deepEqual(findUmbrellaPinDrift(umbrella, versions), []);
    });
});
