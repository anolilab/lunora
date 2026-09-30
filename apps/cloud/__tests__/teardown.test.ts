import { describe, expect, it } from "vitest";

import type { TeardownPorts, TeardownTarget } from "../src/deploy/teardown";
import { runTeardownSweep } from "../src/deploy/teardown";
import type { DestroyRef } from "../src/provision";

const target = (id: string, overrides: Partial<TeardownTarget> = {}): TeardownTarget => {
    return { alias: id, destroyWorker: false, dispatchNamespace: "lunora-preview", id, ...overrides };
};

const ports = (overrides: Partial<TeardownPorts>): TeardownPorts => {
    return {
        deleteRelease: () => Promise.resolve(),
        destroy: () => Promise.resolve(),
        listPending: () => Promise.resolve([]),
        markTornDown: () => Promise.resolve(),
        releaseAlias: () => Promise.resolve(),
        ...overrides,
    };
};

describe(runTeardownSweep, () => {
    it("deletes each pending row's stored release, never the Worker, when the alias lives on", async () => {
        const deleted: string[] = [];
        const destroyed: DestroyRef[] = [];
        const marked: string[] = [];

        const result = await runTeardownSweep(
            ports({
                deleteRelease: (id) => {
                    deleted.push(id);

                    return Promise.resolve();
                },
                destroy: (reference) => {
                    destroyed.push(reference);

                    return Promise.resolve();
                },
                listPending: () => Promise.resolve([target("a"), target("b")]),
                markTornDown: (id) => {
                    marked.push(id);

                    return Promise.resolve();
                },
            }),
        );

        expect(deleted).toStrictEqual(["a", "b"]);
        expect(destroyed).toStrictEqual([]);
        expect(marked).toStrictEqual(["a", "b"]);
        expect(result).toStrictEqual({ failed: 0, tornDown: 2 });
    });

    it("destroys the Worker and releases the alias for the row that carries destroyWorker", async () => {
        const destroyed: DestroyRef[] = [];
        const released: string[] = [];

        const result = await runTeardownSweep(
            ports({
                destroy: (reference) => {
                    destroyed.push(reference);

                    return Promise.resolve();
                },
                listPending: () => Promise.resolve([target("keep"), target("gone", { destroyWorker: true, dispatchNamespace: "lunora-production" })]),
                releaseAlias: (alias) => {
                    released.push(alias);

                    return Promise.resolve();
                },
            }),
        );

        expect(destroyed).toStrictEqual([{ alias: "gone", dispatchNamespace: "lunora-production" }]);
        expect(released).toStrictEqual(["gone"]);
        expect(result).toStrictEqual({ failed: 0, tornDown: 2 });
    });

    it("isolates a failure — the row stays pending, the sweep continues", async () => {
        const marked: string[] = [];

        const result = await runTeardownSweep(
            ports({
                deleteRelease: (id) => (id === "b" ? Promise.reject(new Error("r2 500")) : Promise.resolve()),
                listPending: () => Promise.resolve([target("a"), target("b"), target("c")]),
                markTornDown: (id) => {
                    marked.push(id);

                    return Promise.resolve();
                },
            }),
        );

        expect(marked).toStrictEqual(["a", "c"]);
        expect(result).toStrictEqual({ failed: 1, tornDown: 2 });
    });

    it("does not mark torn down when the mark write fails", async () => {
        const result = await runTeardownSweep(
            ports({ listPending: () => Promise.resolve([target("a")]), markTornDown: () => Promise.reject(new Error("d1 write failed")) }),
        );

        // Left pending (teardownAt unset) so the next tick retries — both deletes are idempotent.
        expect(result).toStrictEqual({ failed: 1, tornDown: 0 });
    });

    it("no-ops on an empty pending set", async () => {
        const never = (): Promise<never> => Promise.reject(new Error("should not be called"));

        const result = await runTeardownSweep(ports({ deleteRelease: never, destroy: never, markTornDown: never, releaseAlias: never }));

        expect(result).toStrictEqual({ failed: 0, tornDown: 0 });
    });

    it("leaves the row pending when the Worker destroy or the alias release fails, so it retries", async () => {
        const marked: string[] = [];

        const result = await runTeardownSweep(
            ports({
                listPending: () => Promise.resolve([target("gone", { destroyWorker: true })]),
                markTornDown: (id) => {
                    marked.push(id);

                    return Promise.resolve();
                },
                releaseAlias: () => Promise.reject(new Error("d1 delete failed")),
            }),
        );

        expect(marked).toStrictEqual([]);
        expect(result).toStrictEqual({ failed: 1, tornDown: 0 });
    });
});
