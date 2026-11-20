import { describe, expect, it, vi } from "vitest";

import type { ControlPlaneDatabase } from "../src/store";
import type { AccountErasurePorts } from "../src/sweeps/account-erasure";
import { MAX_ERASURES_PER_TICK, runAccountErasureSweep } from "../src/sweeps/account-erasure";

/**
 * The orphaned-membership sweep: re-runs the account cleanup for every user that
 * still has a membership but no account, which is what makes a failed
 * after-delete step recoverable.
 */

/** A store that answers `members` in pages of `pageSize`, following its own cursor. */
const pagedStore = (userIds: string[], pageSize: number): ControlPlaneDatabase => {
    return {
        delete: () => Promise.reject(new Error("unused")),
        findMany: (table, args) => {
            if (table !== "members") {
                return Promise.reject(new Error(`unexpected table ${table}`));
            }

            const start = Number(args?.cursor ?? 0);
            const end = start + pageSize;
            const page = userIds.slice(start, end).map((userId, index) => {
                return { _id: `m${String(start + index)}`, organizationId: "org_1", role: "member", userId };
            });

            return Promise.resolve({ continueCursor: end < userIds.length ? String(end) : null, isDone: end >= userIds.length, page });
        },
        insert: () => Promise.reject(new Error("unused")),
        patch: () => Promise.reject(new Error("unused")),
    };
};

/** A store over fixed `members` rows; it refuses every write, so a passing sweep wrote nothing itself. */
const membersStore = (members: Record<string, string>[]): ControlPlaneDatabase => {
    return {
        delete: () => Promise.reject(new Error("unused")),
        findMany: (table) =>
            table === "members"
                ? Promise.resolve({ continueCursor: null, isDone: true, page: members })
                : Promise.reject(new Error(`unexpected table ${table}`)),
        insert: () => Promise.reject(new Error("unused")),
        patch: () => Promise.reject(new Error("unused")),
    };
};

const ports = (existing: string[], erase: AccountErasurePorts["erase"] = () => Promise.resolve(true)) => {
    return {
        erase: vi.fn<AccountErasurePorts["erase"]>(erase),
        existingUserIds: vi.fn<AccountErasurePorts["existingUserIds"]>(() => Promise.resolve(new Set(existing))),
    };
};

describe("orphaned-membership sweep", () => {
    it("erases the users the auth layer no longer has, once each, and leaves the rest", async () => {
        const sweepPorts = ports(["usr_live"]);
        const result = await runAccountErasureSweep(pagedStore(["usr_live", "usr_gone", "usr_gone"], 10), sweepPorts);

        expect(result).toStrictEqual({ erased: ["usr_gone"], failed: [], leftForOperator: [] });
        expect(sweepPorts.erase.mock.calls).toStrictEqual([["usr_gone"]]);
        expect(sweepPorts.existingUserIds.mock.calls).toStrictEqual([[["usr_live", "usr_gone"]]]);
    });

    it("finds an orphan past the first page", async () => {
        const live = Array.from({ length: 5 }, (_, index) => `usr_${String(index)}`);
        const sweepPorts = ports(live);
        const result = await runAccountErasureSweep(pagedStore([...live, "usr_gone"], 2), sweepPorts);

        expect(result.erased).toStrictEqual(["usr_gone"]);
    });

    it("erases nothing when the account lookup fails", async () => {
        const sweepPorts = ports([]);

        sweepPorts.existingUserIds.mockRejectedValue(new Error("auth store unavailable"));

        await expect(runAccountErasureSweep(pagedStore(["usr_a", "usr_b"], 10), sweepPorts)).rejects.toThrow("auth store unavailable");
        expect(sweepPorts.erase).not.toHaveBeenCalled();
    });

    it("caps the erasures per tick and leaves the rest for the next one", async () => {
        const gone = Array.from({ length: MAX_ERASURES_PER_TICK + 5 }, (_, index) => `usr_${String(index)}`);
        const sweepPorts = ports([]);
        const result = await runAccountErasureSweep(pagedStore(gone, 1000), sweepPorts);

        expect(result.erased).toHaveLength(MAX_ERASURES_PER_TICK);
        expect(sweepPorts.erase).toHaveBeenCalledTimes(MAX_ERASURES_PER_TICK);
    });

    it("reports a failed erasure and carries on with the next user", async () => {
        const sweepPorts = ports([], (userId) => (userId === "usr_a" ? Promise.reject(new Error("boom")) : Promise.resolve(userId !== "usr_b")));
        const result = await runAccountErasureSweep(pagedStore(["usr_a", "usr_b", "usr_c"], 10), sweepPorts);

        expect(result).toStrictEqual({ erased: ["usr_c"], failed: ["usr_a", "usr_b"], leftForOperator: [] });
    });

    it("does not ask the auth layer when there are no memberships", async () => {
        const sweepPorts = ports([]);

        await expect(runAccountErasureSweep(pagedStore([], 10), sweepPorts)).resolves.toStrictEqual({ erased: [], failed: [], leftForOperator: [] });
        expect(sweepPorts.existingUserIds).not.toHaveBeenCalled();
    });

    it("reports a deleted sole owner the erasure refused as left for the operator, and writes nothing", async () => {
        const sweepPorts = ports(["usr_peer"], () => Promise.resolve({ refused: ["org_1"] }));
        // The store refuses every write, so a passing sweep wrote nothing itself.
        const store = membersStore([
            { _id: "m_sole", organizationId: "org_1", role: "owner", userId: "usr_removed" },
            { _id: "m_other", organizationId: "org_2", role: "member", userId: "usr_removed" },
            { _id: "m_peer", organizationId: "org_1", role: "member", userId: "usr_peer" },
        ]);

        await expect(runAccountErasureSweep(store, sweepPorts)).resolves.toStrictEqual({
            erased: [],
            failed: [],
            leftForOperator: [{ organizationIds: ["org_1"], userId: "usr_removed" }],
        });
        expect(sweepPorts.erase.mock.calls).toStrictEqual([["usr_removed"]]);
    });

    it("erases a deleted owner the erasure does not refuse, such as one whose organization is gone", async () => {
        const sweepPorts = ports([]);
        const store = membersStore([{ _id: "m_old", organizationId: "org_gone", role: "owner", userId: "usr_removed" }]);

        await expect(runAccountErasureSweep(store, sweepPorts)).resolves.toStrictEqual({ erased: ["usr_removed"], failed: [], leftForOperator: [] });
    });

    it("does not count refused sole owners against the per-tick cap", async () => {
        const sole = Array.from({ length: MAX_ERASURES_PER_TICK + 5 }, (_, index) => {
            return { _id: `m_sole_${String(index)}`, organizationId: `org_${String(index)}`, role: "owner", userId: `usr_sole_${String(index)}` };
        });
        const sweepPorts = ports([], (userId) => Promise.resolve(userId.startsWith("usr_sole_") ? { refused: ["org"] } : true));
        const result = await runAccountErasureSweep(
            membersStore([...sole, { _id: "m_real", organizationId: "org_x", role: "member", userId: "usr_real" }]),
            sweepPorts,
        );

        expect(result.erased).toStrictEqual(["usr_real"]);
        expect(result.leftForOperator).toHaveLength(sole.length);
    });

    it("still reports a sole owner found after the per-tick cap is reached", async () => {
        const gone = Array.from({ length: MAX_ERASURES_PER_TICK + 2 }, (_, index) => {
            return { _id: `m_${String(index)}`, organizationId: "org_shared", role: "member", userId: `usr_${String(index)}` };
        });
        const sweepPorts = ports([], (userId) => Promise.resolve(userId === "usr_sole" ? { refused: ["org_sole"] } : true));
        const result = await runAccountErasureSweep(
            membersStore([...gone, { _id: "m_sole", organizationId: "org_sole", role: "owner", userId: "usr_sole" }]),
            sweepPorts,
        );

        expect(result.erased).toHaveLength(MAX_ERASURES_PER_TICK);
        expect(result.leftForOperator).toStrictEqual([{ organizationIds: ["org_sole"], userId: "usr_sole" }]);
    });
});
