import { describe, expect, it } from "vitest";

import type { TeardownTarget } from "../src/deploy/teardown";
import { runTeardownSweep } from "../src/deploy/teardown";

const target = (id: string, kind = "preview"): TeardownTarget => {
    return {
        alias: id,
        deleteResources: false,
        dispatchNamespace: `lunora-${kind}`,
        id,
        scriptName: `${id}-v1`,
    };
};

describe(runTeardownSweep, () => {
    it("deletes each pending script and marks it torn down", async () => {
        const destroyed: string[] = [];
        const marked: string[] = [];

        const result = await runTeardownSweep({
            destroy: (reference) => {
                destroyed.push(reference.scriptName);

                return Promise.resolve();
            },
            listPending: () => Promise.resolve([target("a"), target("b")]),
            markTornDown: (id) => {
                marked.push(id);

                return Promise.resolve();
            },
            releaseAlias: () => Promise.resolve(),
        });

        expect(destroyed).toStrictEqual(["a-v1", "b-v1"]);
        expect(marked).toStrictEqual(["a", "b"]);
        expect(result).toStrictEqual({ failed: 0, tornDown: 2 });
    });

    it("passes the kind-derived dispatch namespace to destroy", async () => {
        let namespace: string | undefined;

        await runTeardownSweep({
            destroy: (reference) => {
                namespace = reference.dispatchNamespace;

                return Promise.resolve();
            },
            listPending: () => Promise.resolve([target("x", "production")]),
            markTornDown: () => Promise.resolve(),
            releaseAlias: () => Promise.resolve(),
        });

        expect(namespace).toBe("lunora-production");
    });

    it("isolates a Cloudflare failure — the row stays pending, the sweep continues", async () => {
        const marked: string[] = [];

        const result = await runTeardownSweep({
            destroy: (reference) => (reference.scriptName === "b-v1" ? Promise.reject(new Error("cf 500")) : Promise.resolve()),
            listPending: () => Promise.resolve([target("a"), target("b"), target("c")]),
            markTornDown: (id) => {
                marked.push(id);

                return Promise.resolve();
            },
            releaseAlias: () => Promise.resolve(),
        });

        // b failed and was never marked; a and c still torn down.
        expect(marked).toStrictEqual(["a", "c"]);
        expect(result).toStrictEqual({ failed: 1, tornDown: 2 });
    });

    it("does not mark torn down when the delete succeeds but the mark write fails", async () => {
        const result = await runTeardownSweep({
            destroy: () => Promise.resolve(),
            listPending: () => Promise.resolve([target("a")]),
            markTornDown: () => Promise.reject(new Error("d1 write failed")),
            releaseAlias: () => Promise.resolve(),
        });

        // Left pending (teardownAt unset) so the next tick retries — the 404-
        // tolerant delete makes the retry safe.
        expect(result).toStrictEqual({ failed: 1, tornDown: 0 });
    });

    it("no-ops on an empty pending set", async () => {
        const result = await runTeardownSweep({
            destroy: () => Promise.reject(new Error("should not be called")),
            listPending: () => Promise.resolve([]),
            markTornDown: () => Promise.reject(new Error("should not be called")),
            releaseAlias: () => Promise.reject(new Error("should not be called")),
        });

        expect(result).toStrictEqual({ failed: 0, tornDown: 0 });
    });

    it("releases the alias only when its last deployment is torn down (deleteResources)", async () => {
        const released: string[] = [];
        const lastOfAlias = (id: string): TeardownTarget => {
            return { ...target(id), deleteResources: true };
        };

        const result = await runTeardownSweep({
            destroy: () => Promise.resolve(),
            // "keep" is a routine version prune (deleteResources=false); "gone" is the last one.
            listPending: () => Promise.resolve([target("keep"), lastOfAlias("gone")]),
            markTornDown: () => Promise.resolve(),
            releaseAlias: (alias) => {
                released.push(alias);

                return Promise.resolve();
            },
        });

        expect(released).toStrictEqual(["gone"]);
        expect(result).toStrictEqual({ failed: 0, tornDown: 2 });
    });

    it("leaves the row pending (no markTornDown) when releaseAlias fails, so it retries", async () => {
        const marked: string[] = [];

        const result = await runTeardownSweep({
            destroy: () => Promise.resolve(),
            listPending: () => Promise.resolve([{ ...target("gone"), deleteResources: true }]),
            markTornDown: (id) => {
                marked.push(id);

                return Promise.resolve();
            },
            releaseAlias: () => Promise.reject(new Error("d1 delete failed")),
        });

        expect(marked).toStrictEqual([]);
        expect(result).toStrictEqual({ failed: 1, tornDown: 0 });
    });
});
