/**
 * `node --test plugins/lunora/scripts/verify-turn.test.mjs` — the branches of
 * the Stop-hook gate that decide whether a turn gets blocked. Everything here
 * is pure; the filesystem and spawn calls are injected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { backendIsDirty, decide, findLunoraBin, findProjectRoot } from "./verify-turn.mjs";

/** An `existsSync` double over a fixed set of paths. */
const fs = (...paths) => {
    const set = new Set(paths);

    return (path) => set.has(path);
};

test("findProjectRoot needs a lunora/ directory AND a wrangler config", () => {
    assert.equal(findProjectRoot("/repo", fs("/repo/lunora", "/repo/wrangler.jsonc")), "/repo");
    assert.equal(findProjectRoot("/repo", fs("/repo/lunora", "/repo/wrangler.json")), "/repo");
    // A bare `lunora/` is not a project — packages/lunora, sdks/*/lunora, a
    // sibling checkout named `lunora`.
    assert.equal(findProjectRoot("/repo", fs("/repo/lunora")), undefined);
});

test("findProjectRoot walks up from a subdirectory", () => {
    assert.equal(findProjectRoot("/repo/src/features", fs("/repo/lunora", "/repo/wrangler.jsonc")), "/repo");
});

test("findProjectRoot stops at the repository boundary", () => {
    // A sibling checkout at /work/lunora + /work/wrangler.jsonc must not be
    // selected from inside an unrelated repo at /work/other.
    const layout = fs("/work/other/.git", "/work/lunora", "/work/wrangler.jsonc");

    assert.equal(findProjectRoot("/work/other/src", layout), undefined);
});

test("backendIsDirty verifies when git cannot answer", () => {
    assert.equal(
        backendIsDirty("/repo", () => ({ error: new Error("no git"), status: null, stdout: "" })),
        true,
    );
    assert.equal(
        backendIsDirty("/repo", () => ({ status: 128, stdout: "" })),
        true,
    );
});

test("backendIsDirty skips a clean backend and runs on a dirty one", () => {
    assert.equal(
        backendIsDirty("/repo", () => ({ status: 0, stdout: "\n" })),
        false,
    );
    assert.equal(
        backendIsDirty("/repo", () => ({ status: 0, stdout: " M lunora/schema.ts\n" })),
        true,
    );
});

test("a clean verify does not block", () => {
    assert.deepEqual(decide({ output: "verify: project is valid", status: 0 }), { block: false });
});

test("a failed verify blocks and hands back the TAIL of the output", () => {
    // `lunora verify` streams progress first and prints its error summary last,
    // so a head-slice would drop the part that names the failing step.
    const output = `${"codegen progress noise\n".repeat(500)}lunora/messages.ts(12,5): error TS2345: nope\nverify: errors:\n  - type errors: tsc --noEmit exited 2`;
    const decision = decide({ output, status: 1 });

    assert.equal(decision.block, true);
    assert.match(decision.reason, /verify: errors:/u);
    assert.match(decision.reason, /error TS2345: nope/u);
});

test("findLunoraBin walks up to a hoisted node_modules and gives up when there is none", () => {
    assert.equal(findLunoraBin("/repo/apps/web", fs("/repo/node_modules/.bin/lunora")), "/repo/node_modules/.bin/lunora");
    assert.equal(findLunoraBin("/repo/apps/web", fs("/repo/node_modules/.bin/lunora.cmd")), "/repo/node_modules/.bin/lunora.cmd");
    assert.equal(
        findLunoraBin("/repo/apps/web", () => false),
        undefined,
    );
});
