import { describe, expect, it, vi } from "vitest";

import type { CloudflareApi } from "../src/cloudflare/api";
import type { TeardownTarget } from "../src/deploy/teardown";
import { createResourceTeardown, runTeardownSweep } from "../src/deploy/teardown";

const target = (id: string, kind = "preview"): TeardownTarget => ({ dispatchNamespace: `lunora-${kind}`, id, scriptName: `${id}-v1` });

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
        });

        expect(result).toStrictEqual({ failed: 0, tornDown: 0 });
    });
});

const cloudflareApi = (over: Partial<CloudflareApi> = {}): CloudflareApi => ({
    createCustomHostname: () => Promise.resolve({ id: "h" }),
    createD1Database: () => Promise.resolve({ uuid: "u" }),
    createR2Bucket: () => Promise.resolve(),
    deleteD1Database: () => Promise.resolve(),
    deleteDispatchScript: () => Promise.resolve(),
    deleteR2Bucket: () => Promise.resolve(),
    findD1DatabaseByName: () => Promise.resolve(null),
    putDispatchScript: () => Promise.resolve(),
    putSecret: () => Promise.resolve(),
    ...over,
});

describe(createResourceTeardown, () => {
    it("deletes the script, then the D1 database (resolved by name), then the R2 bucket", async () => {
        const deleteDispatchScript = vi.fn(() => Promise.resolve());
        const deleteD1Database = vi.fn(() => Promise.resolve());
        const deleteR2Bucket = vi.fn(() => Promise.resolve());
        const findD1DatabaseByName = vi.fn((name: string) => Promise.resolve(name === "app-v1-db" ? { uuid: "d1-uuid" } : null));

        const destroy = createResourceTeardown(cloudflareApi({ deleteD1Database, deleteDispatchScript, deleteR2Bucket, findD1DatabaseByName }));

        await destroy({ dispatchNamespace: "lunora-preview", scriptName: "app-v1" });

        expect(deleteDispatchScript).toHaveBeenCalledWith({ namespace: "lunora-preview", scriptName: "app-v1" });
        expect(findD1DatabaseByName).toHaveBeenCalledWith("app-v1-db");
        expect(deleteD1Database).toHaveBeenCalledWith("d1-uuid");
        expect(deleteR2Bucket).toHaveBeenCalledWith("app-v1-files");
    });

    it("skips D1 deletion when no database exists for the script (convention miss = no-op)", async () => {
        const deleteD1Database = vi.fn(() => Promise.resolve());

        const destroy = createResourceTeardown(cloudflareApi({ deleteD1Database, findD1DatabaseByName: () => Promise.resolve(null) }));

        await destroy({ dispatchNamespace: "lunora-production", scriptName: "app-v2" });

        expect(deleteD1Database).not.toHaveBeenCalled();
    });

    it("swallows a non-empty R2 failure (logged) so script + D1 teardown still completes", async () => {
        const onR2Error = vi.fn();
        const destroy = createResourceTeardown(
            cloudflareApi({
                deleteR2Bucket: () => Promise.reject(new Error("bucket not empty")),
                findD1DatabaseByName: () => Promise.resolve({ uuid: "u" }),
            }),
            onR2Error,
        );

        // Does not throw despite the R2 failure.
        await expect(destroy({ dispatchNamespace: "lunora-preview", scriptName: "app-v1" })).resolves.toBeUndefined();
        expect(onR2Error).toHaveBeenCalledWith("app-v1-files", expect.any(Error));
    });

    it("propagates a script/D1 failure so the sweep leaves the target pending (retryable)", async () => {
        const destroy = createResourceTeardown(cloudflareApi({ deleteDispatchScript: () => Promise.reject(new Error("cf 500")) }));

        await expect(destroy({ dispatchNamespace: "lunora-preview", scriptName: "app-v1" })).rejects.toThrow("cf 500");
    });
});
