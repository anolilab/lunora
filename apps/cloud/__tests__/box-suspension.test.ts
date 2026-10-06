import { describe, expect, it, vi } from "vitest";

import { runBoxSuspensionSweep } from "../src/boxes/suspension-sweep";
import { memoryStore } from "./support/memory-store";

/**
 * The suspension sweep (plan 365): suspensions and recoveries happen in
 * mutations that cannot reach a box, so this pushes a fresh routing table to
 * every online box whose last push no longer matches its orgs' rows — and only
 * those.
 */

const world = (box: Record<string, unknown>, org1: Record<string, unknown>) =>
    memoryStore({
        boxes: [{ _id: "box_1", status: "online", ...box }],
        organizations: [
            { _id: "org_1", plan: "free", ...org1 },
            { _id: "org_2", plan: "free" },
        ],
        projects: [
            { _id: "proj_1", organizationId: "org_1", placementRef: "box_1" },
            { _id: "proj_2", organizationId: "org_2", placementRef: "box_1" },
        ],
    });

const sweep = async (store: ReturnType<typeof memoryStore>, push = vi.fn<(boxId: string) => Promise<boolean>>(() => Promise.resolve(true))) => {
    const result = await runBoxSuspensionSweep(store, { log: () => undefined, now: Date.now(), push });

    return { push, result };
};

describe(runBoxSuspensionSweep, () => {
    it("pushes a box whose org was suspended since its last push", async () => {
        const { push, result } = await sweep(world({ routesWithheld: [] }, { suspendedAt: 1 }));

        expect(push).toHaveBeenCalledWith("box_1");
        expect(result).toStrictEqual({ failed: 0, pushed: 1 });
    });

    it("pushes a box whose org recovered since its last push", async () => {
        const { push } = await sweep(world({ routesWithheld: ["org_1"] }, { suspendedAt: null }));

        expect(push).toHaveBeenCalledWith("box_1");
    });

    it("leaves a box whose last push already matches", async () => {
        const { push } = await sweep(world({ routesWithheld: ["org_1"] }, { suspendedAt: 1 }));

        expect(push).not.toHaveBeenCalled();
    });

    it("leaves offline and revoked boxes to their reconnect", async () => {
        const offline = await sweep(world({ status: "offline" }, { suspendedAt: 1 }));
        const revoked = await sweep(world({ revokedAt: 1 }, { suspendedAt: 1 }));

        expect(offline.push).not.toHaveBeenCalled();
        expect(revoked.push).not.toHaveBeenCalled();
    });

    it("reports a failed push and retries it next tick", async () => {
        const store = world({}, { suspendedAt: 1 });
        const failing = vi.fn<(boxId: string) => Promise<boolean>>(() => Promise.reject(new Error("session unreachable")));

        await expect(sweep(store, failing)).resolves.toMatchObject({ result: { failed: 1, pushed: 0 } });
        await expect(sweep(store)).resolves.toMatchObject({ result: { pushed: 1 } });
    });
});
