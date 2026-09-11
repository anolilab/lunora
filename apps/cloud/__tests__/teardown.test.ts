import { describe, expect, it, vi } from "vitest";

import type { CloudflareApi } from "../src/cloudflare/api";
import type { TeardownTarget } from "../src/deploy/teardown";
import { createResourceTeardown, runTeardownSweep } from "../src/deploy/teardown";

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

const cloudflareApi = (over: Partial<CloudflareApi> = {}): CloudflareApi => {
    return {
        createCustomHostname: () => Promise.resolve({ id: "h" }),
        createD1Database: () => Promise.resolve({ uuid: "u" }),
        createR2Bucket: () => Promise.resolve(),
        deleteD1Database: () => Promise.resolve(),
        deleteDispatchScript: () => Promise.resolve(),
        deleteR2Bucket: () => Promise.resolve(),
        exportD1Database: () => Promise.resolve({ signedUrl: "https://example.invalid/dump.sql" }),
        findD1DatabaseByName: () => Promise.resolve(null),
        putDispatchScript: () => Promise.resolve(),
        putSecret: () => Promise.resolve(),
        ...over,
    };
};

const ref = (over: Partial<Parameters<ReturnType<typeof createResourceTeardown>>[0]> = {}): Parameters<ReturnType<typeof createResourceTeardown>>[0] => {
    return {
        alias: "app",
        deleteResources: true,
        dispatchNamespace: "lunora-preview",
        scriptName: "app-v1",
        ...over,
    };
};

describe(createResourceTeardown, () => {
    it("deletes the script, then the alias-keyed D1 + R2, when deleteResources is set", async () => {
        const deleteDispatchScript = vi.fn<CloudflareApi["deleteDispatchScript"]>(() => Promise.resolve());
        const deleteD1Database = vi.fn<CloudflareApi["deleteD1Database"]>(() => Promise.resolve());
        const deleteR2Bucket = vi.fn<CloudflareApi["deleteR2Bucket"]>(() => Promise.resolve());
        const findD1DatabaseByName = vi.fn<CloudflareApi["findD1DatabaseByName"]>((name) => Promise.resolve(name === "app-db" ? { uuid: "d1-uuid" } : null));

        const destroy = createResourceTeardown(cloudflareApi({ deleteD1Database, deleteDispatchScript, deleteR2Bucket, findD1DatabaseByName }));

        await destroy(ref({ deleteResources: true }));

        expect(deleteDispatchScript).toHaveBeenCalledWith({ namespace: "lunora-preview", scriptName: "app-v1" });
        // Resource names come from the stable alias, not the versioned script.
        expect(findD1DatabaseByName).toHaveBeenCalledWith("app-db");
        expect(deleteD1Database).toHaveBeenCalledWith("d1-uuid");
        expect(deleteR2Bucket).toHaveBeenCalledWith("app-files");
    });

    it("deletes ONLY the script when deleteResources is false (version prune keeps the shared DB)", async () => {
        const deleteDispatchScript = vi.fn<CloudflareApi["deleteDispatchScript"]>(() => Promise.resolve());
        const findD1DatabaseByName = vi.fn<CloudflareApi["findD1DatabaseByName"]>(() => Promise.resolve({ uuid: "u" }));
        const deleteD1Database = vi.fn<CloudflareApi["deleteD1Database"]>(() => Promise.resolve());
        const deleteR2Bucket = vi.fn<CloudflareApi["deleteR2Bucket"]>(() => Promise.resolve());

        const destroy = createResourceTeardown(cloudflareApi({ deleteD1Database, deleteDispatchScript, deleteR2Bucket, findD1DatabaseByName }));

        await destroy(ref({ deleteResources: false }));

        expect(deleteDispatchScript).toHaveBeenCalledTimes(1);
        expect(findD1DatabaseByName).not.toHaveBeenCalled();
        expect(deleteD1Database).not.toHaveBeenCalled();
        expect(deleteR2Bucket).not.toHaveBeenCalled();
    });

    it("skips D1 deletion when no database exists for the alias (convention miss = no-op)", async () => {
        const deleteD1Database = vi.fn<CloudflareApi["deleteD1Database"]>(() => Promise.resolve());

        const destroy = createResourceTeardown(cloudflareApi({ deleteD1Database, findD1DatabaseByName: () => Promise.resolve(null) }));

        await destroy(ref({ alias: "app2", deleteResources: true }));

        expect(deleteD1Database).not.toHaveBeenCalled();
    });

    it("swallows a non-empty R2 failure (logged) so script + D1 teardown still completes", async () => {
        const onR2Error = vi.fn<(bucket: string, error: unknown) => void>();
        const destroy = createResourceTeardown(
            cloudflareApi({ deleteR2Bucket: () => Promise.reject(new Error("bucket not empty")), findD1DatabaseByName: () => Promise.resolve({ uuid: "u" }) }),
            onR2Error,
        );

        await expect(destroy(ref({ deleteResources: true }))).resolves.toBeUndefined();
        expect(onR2Error).toHaveBeenCalledWith("app-files", expect.any(Error));
    });

    it("propagates a script failure so the sweep leaves the target pending (retryable)", async () => {
        const destroy = createResourceTeardown(cloudflareApi({ deleteDispatchScript: () => Promise.reject(new Error("cf 500")) }));

        await expect(destroy(ref())).rejects.toThrow("cf 500");
    });
});
