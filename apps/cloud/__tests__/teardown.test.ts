import { describe, expect, it } from "vitest";

import type { TeardownPorts, TeardownTarget } from "../src/deploy/teardown";
import { runTeardownSweep } from "../src/deploy/teardown";

const target = (id: string, overrides: Partial<TeardownTarget> = {}): TeardownTarget => {
    return { alias: id, destroyWorker: false, id, projectId: "prj_1", target: "cloudflare-wfp", ...overrides };
};

const ports = (overrides: Partial<TeardownPorts>): TeardownPorts => {
    return {
        aliasInUse: () => Promise.resolve(false),
        deleteRelease: () => Promise.resolve(),
        destroy: () => Promise.resolve(),
        holdAlias: () => Promise.resolve(true),
        listPending: () => Promise.resolve([]),
        markTornDown: () => Promise.resolve(),
        releaseAlias: () => Promise.resolve(),
        unholdAlias: () => Promise.resolve(),
        ...overrides,
    };
};

describe(runTeardownSweep, () => {
    it("deletes each pending row's stored release, never the Worker, when the alias lives on", async () => {
        const deleted: string[] = [];
        const destroyed: TeardownTarget[] = [];
        const marked: string[] = [];

        const result = await runTeardownSweep(
            ports({
                deleteRelease: (id) => {
                    deleted.push(id);

                    return Promise.resolve();
                },
                destroy: (pending) => {
                    destroyed.push(pending);

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
        const destroyed: TeardownTarget[] = [];
        const released: string[] = [];

        const result = await runTeardownSweep(
            ports({
                destroy: (pending) => {
                    destroyed.push(pending);

                    return Promise.resolve();
                },
                listPending: () => Promise.resolve([target("keep"), target("gone", { destroyWorker: true })]),
                releaseAlias: (alias, projectId) => {
                    released.push(`${alias}@${projectId}`);

                    return Promise.resolve();
                },
            }),
        );

        // The row itself — its target and alias pick the driver.
        expect(destroyed).toStrictEqual([target("gone", { destroyWorker: true })]);
        expect(released).toStrictEqual(["gone@prj_1"]);
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

    it("keeps the tenant and the claim of an alias a release was created for since listPending read it", async () => {
        const destroyed: string[] = [];
        const released: string[] = [];
        const marked: string[] = [];

        const result = await runTeardownSweep(
            ports({
                aliasInUse: () => Promise.resolve(true),
                destroy: (pending) => {
                    destroyed.push(pending.alias);

                    return Promise.resolve();
                },
                listPending: () => Promise.resolve([target("gone", { destroyWorker: true })]),
                markTornDown: (id) => {
                    marked.push(id);

                    return Promise.resolve();
                },
                releaseAlias: (alias) => {
                    released.push(alias);

                    return Promise.resolve();
                },
            }),
        );

        // The destroyed row still drops its own bundle; the new release keeps the rest.
        expect(destroyed).toStrictEqual([]);
        expect(released).toStrictEqual([]);
        expect(marked).toStrictEqual(["gone"]);
        expect(result).toStrictEqual({ failed: 0, tornDown: 1 });
    });

    it("keeps the claim when a release for the alias is created while its tenant is destroyed", async () => {
        const answers = [false, true];
        const released: string[] = [];

        await runTeardownSweep(
            ports({
                aliasInUse: () => Promise.resolve(answers.shift() ?? true),
                listPending: () => Promise.resolve([target("gone", { destroyWorker: true })]),
                releaseAlias: (alias) => {
                    released.push(alias);

                    return Promise.resolve();
                },
            }),
        );

        expect(released).toStrictEqual([]);
    });

    it("holds the alias before asking whether it is in use, and keeps holding it through the destroy", async () => {
        const steps: string[] = [];
        const step =
            <T>(name: string, value: T) =>
            (): Promise<T> => {
                steps.push(name);

                return Promise.resolve(value);
            };

        await runTeardownSweep(
            ports({
                aliasInUse: step("aliasInUse", false),
                destroy: step("destroy", undefined),
                holdAlias: step("holdAlias", true),
                listPending: () => Promise.resolve([target("gone", { destroyWorker: true })]),
                releaseAlias: step("releaseAlias", undefined),
                unholdAlias: step("unholdAlias", undefined),
            }),
        );

        // Released with the claim, never cleared before the destroy finished.
        expect(steps).toStrictEqual(["holdAlias", "aliasInUse", "destroy", "aliasInUse", "releaseAlias"]);
    });

    it.each([
        ["the alias has a release", { aliasInUse: () => Promise.resolve(true) }],
        ["the destroy fails", { destroy: () => Promise.reject(new Error("driver down")) }],
    ])("clears the hold when %s, so the next release is not refused", async (_label, overrides: Partial<TeardownPorts>) => {
        const unheld: string[] = [];

        await runTeardownSweep(
            ports({
                listPending: () => Promise.resolve([target("gone", { destroyWorker: true })]),
                unholdAlias: (alias) => {
                    unheld.push(alias);

                    return Promise.resolve();
                },
                ...overrides,
            }),
        );

        expect(unheld).toStrictEqual(["gone"]);
    });

    it("destroys nothing when another project owns the alias, whose tenant it now is", async () => {
        const destroyed: string[] = [];

        const result = await runTeardownSweep(
            ports({
                destroy: (pending) => {
                    destroyed.push(pending.alias);

                    return Promise.resolve();
                },
                holdAlias: () => Promise.resolve(false),
                listPending: () => Promise.resolve([target("gone", { destroyWorker: true })]),
            }),
        );

        expect(destroyed).toStrictEqual([]);
        expect(result).toStrictEqual({ failed: 0, tornDown: 1 });
    });
});
