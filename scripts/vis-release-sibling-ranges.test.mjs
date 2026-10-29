/**
 * vis's version step rewrites every sibling specifier to `<operator><new version>`;
 * these pin which of those rewrites the plugin undoes. The fixtures are the shapes
 * the first rehearsal under vis 6 produced for @lunora/client.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { restoreSiblingRanges } from "./vis-release-sibling-ranges.js";

test("restores a peer range the new version still satisfies", () => {
    const restored = restoreSiblingRanges(
        { peerDependencies: { "@lunora/runtime": ">=1.0.0-alpha.76 <2.0.0-0" } },
        { peerDependencies: { "@lunora/runtime": ">=1.0.0-alpha.252" } },
    );

    assert.deepEqual(restored, { peerDependencies: { "@lunora/runtime": ">=1.0.0-alpha.76 <2.0.0-0" } });
});

test("restores a dependency range, and only the field it came from", () => {
    const restored = restoreSiblingRanges(
        {
            dependencies: { "@lunora/errors": ">=1.0.0-alpha.51 <2.0.0-0" },
            devDependencies: { "@lunora/do": "1.0.0-alpha.259" },
        },
        {
            dependencies: { "@lunora/errors": ">=1.0.0-alpha.77" },
            devDependencies: { "@lunora/do": "^1.0.0-alpha.260" },
        },
    );

    assert.deepEqual(restored, {
        dependencies: { "@lunora/errors": ">=1.0.0-alpha.51 <2.0.0-0" },
        devDependencies: { "@lunora/do": "^1.0.0-alpha.260" },
    });
});

test("keeps the rewrite when the new version has outgrown the range", () => {
    const restored = restoreSiblingRanges(
        { peerDependencies: { "@lunora/runtime": ">=1.0.0-alpha.76 <2.0.0-0" } },
        { peerDependencies: { "@lunora/runtime": ">=1.0.1-alpha.0" } },
    );

    assert.equal(restored, undefined);
});

test("leaves exact pins, protocols and non-siblings alone", () => {
    const restored = restoreSiblingRanges(
        {
            dependencies: { "@lunora/wire": "1.0.0-alpha.3", react: ">=18 <20" },
            devDependencies: { "@lunora/cli": "workspace:*" },
        },
        {
            dependencies: { "@lunora/wire": "^1.0.0-alpha.4", react: ">=19" },
            devDependencies: { "@lunora/cli": "workspace:*" },
        },
    );

    assert.equal(restored, undefined);
});
