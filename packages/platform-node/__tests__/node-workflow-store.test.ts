import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createNodeWorkflowStore } from "../src/node-workflow-store";

const run = (overrides: Record<string, unknown> = {}): Parameters<ReturnType<typeof createNodeWorkflowStore>["save"]>[0] => {
    return {
        definitionId: "greet",
        runId: "run-1",
        snapshot: { value: "waiting" },
        status: "waiting",
        updatedAt: 1000,
        ...overrides,
    };
};

describe("createNodeWorkflowStore", () => {
    let directory: string;

    afterEach(() => {
        if (directory) {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    const freshPath = (): string => {
        directory = mkdtempSync(join(tmpdir(), "lunora-platform-node-wfstore-"));

        return join(directory, "workflows.sqlite3");
    };

    it("round-trips a run and drops it on delete", async () => {
        expect.hasAssertions();

        const store = createNodeWorkflowStore(new Database(freshPath()));

        await store.save(run({ eventName: "approved", wakeAt: 5000 }));

        await expect(store.load("run-1")).resolves.toStrictEqual({
            definitionId: "greet",
            eventName: "approved",
            runId: "run-1",
            snapshot: { value: "waiting" },
            status: "waiting",
            updatedAt: 1000,
            wakeAt: 5000,
        });

        // Absent optional columns come back absent, not null.
        await store.save(run({ runId: "run-2" }));

        const bare = await store.load("run-2");

        expect(bare?.eventName).toBeUndefined();
        expect(bare?.wakeAt).toBeUndefined();

        await store.delete("run-1");

        await expect(store.load("run-1")).resolves.toBeUndefined();
    });

    it("due returns only wakeable runs at or before now, in wake order", async () => {
        expect.hasAssertions();

        const store = createNodeWorkflowStore(new Database(freshPath()));

        await store.save(run({ runId: "later", status: "suspended", wakeAt: 300 }));
        await store.save(run({ runId: "sooner", status: "suspended", wakeAt: 100 }));
        await store.save(run({ runId: "not-yet", status: "suspended", wakeAt: 9000 }));
        // Terminal, so never due however old its wakeAt.
        await store.save(run({ runId: "done", status: "completed", wakeAt: 1 }));
        // Untimed wait — advanced by a signal, not by the sweep.
        await store.save(run({ runId: "untimed", status: "waiting", wakeAt: undefined }));

        await expect(store.due(500, 10)).resolves.toStrictEqual(["sooner", "later"]);
        await expect(store.due(500, 1)).resolves.toStrictEqual(["sooner"]);
    });

    it("acquire is exclusive across two connections to one database file", async () => {
        expect.hasAssertions();

        const path = freshPath();
        const first = createNodeWorkflowStore(new Database(path));
        const second = createNodeWorkflowStore(new Database(path));

        // The claim is what the store's docstring argues hardest for: two
        // processes over one file must not both believe they own the run.
        await expect(first.acquire!("run-1", "token-a", 60_000)).resolves.toBe(true);
        await expect(second.acquire!("run-1", "token-b", 60_000)).resolves.toBe(false);

        // Re-acquiring with the same token is idempotent, not a refusal.
        await expect(first.acquire!("run-1", "token-a", 60_000)).resolves.toBe(true);

        // A release by the wrong token is a no-op.
        await second.release!("run-1", "token-b");

        await expect(second.acquire!("run-1", "token-b", 60_000)).resolves.toBe(false);

        await first.release!("run-1", "token-a");

        await expect(second.acquire!("run-1", "token-b", 60_000)).resolves.toBe(true);
    });

    it("acquire takes over an expired lease", async () => {
        expect.hasAssertions();

        const store = createNodeWorkflowStore(new Database(freshPath()));

        await expect(store.acquire!("run-1", "token-a", 0)).resolves.toBe(true);
        await expect(store.acquire!("run-1", "token-b", 60_000)).resolves.toBe(true);
        await expect(store.acquire!("run-1", "token-c", 60_000)).resolves.toBe(false);
    });

    it("delete drops the lease with the run", async () => {
        expect.hasAssertions();

        const store = createNodeWorkflowStore(new Database(freshPath()));

        await store.save(run());
        await store.acquire!("run-1", "token-a", 60_000);
        await store.delete("run-1");

        // No orphan lease row survives the run it belonged to.
        await expect(store.acquire!("run-1", "token-b", 60_000)).resolves.toBe(true);
    });
});
