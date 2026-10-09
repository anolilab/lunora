import { describe, expect, it, vi } from "vitest";

import type { HaltRow } from "../src/deploy/halt";
import { haltAlias } from "../src/deploy/halt-converge";
import { createDeployPacer } from "../src/deploy/pacing";
import type { DeployManifest } from "../src/provision-contract";
import { storeRowReader } from "../src/targets/placement";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";
import { memoryStore } from "./support/memory-store";

/**
 * The last line of the emergency stop's data safety: whatever `buildHaltStub`
 * hands back, `haltAlias` refuses a stub that stops binding a class the live
 * release binds BEFORE anything converges — the converge would delete that
 * class's data. The generator is replaced here by one that drops a class, so
 * the guard is what stands between it and the driver.
 */
vi.mock(import("../src/deploy/halt-stub"), async (importOriginal) => {
    const original = await importOriginal();

    return {
        ...original,
        buildHaltStub: (onWorker: ReadonlyArray<DeployManifest>, reason: string) => {
            const stub = original.buildHaltStub(onWorker, reason);

            return { ...stub, manifest: { ...stub.manifest, bindings: stub.manifest.bindings.filter((binding) => binding.className !== "Legacy") } };
        },
    };
});

describe("a stub that drops a class", () => {
    it("is refused before the driver is ever called", async () => {
        const database = memoryStore({
            deployments: [
                {
                    _id: "d_1",
                    adminToken: "t",
                    alias: "acme",
                    createdAt: 1,
                    kind: "production",
                    organizationId: "org_1",
                    projectId: "p_1",
                    scriptName: "acme",
                    status: "live",
                    target: "cloudflare-wfp",
                },
            ],
        });
        const releases = memoryReleaseStore();
        const deploy = vi.fn<() => Promise<{ url: string }>>(async () => {
            return { url: "https://acme.test" };
        });

        await releases.store.put("d_1", {
            bundle: "",
            manifest: {
                bindings: [
                    { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" },
                    { binding: "LEGACY", className: "Legacy", sqlite: false, type: "durable_object" },
                ],
            },
        });

        const row = { _id: "h_1", alias: "acme", organizationId: "org_1", projectId: "p_1", reason: "manual", state: "halting" } as HaltRow;

        await expect(
            haltAlias(row, {
                database,
                driverFor: () => fakeDriver({ deploy }),
                pacer: createDeployPacer(),
                read: storeRowReader(database),
                releases: releases.store,
            }),
        ).rejects.toThrow(/missing LEGACY → Legacy .*would delete the data of Legacy/u);
        expect(deploy).not.toHaveBeenCalled();
    });
});
