import { describe, expect, it, vi } from "vitest";

import { OWNER_REMOVED_ACTION, ownerRemovedTarget } from "../lunora/account";
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

/** A store over fixed `members` rows and the `organization.owner-removed` marks of `markedIds`, matching `where` by equality. */
const markedStore = (members: Record<string, string>[], markedIds: string[]): ControlPlaneDatabase => {
    const auditLog = members
        .filter((row) => markedIds.includes(row["_id"] ?? ""))
        .map((row) => {
            return { action: OWNER_REMOVED_ACTION, organizationId: row["organizationId"], target: ownerRemovedTarget(row["_id"] ?? "") };
        });
    const tables: Record<string, Record<string, unknown>[]> = { auditLog, members };

    return {
        delete: () => Promise.reject(new Error("unused")),
        findMany: (table, args) => {
            const where = args?.where ?? {};
            const page = (tables[table] ?? []).filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));

            return Promise.resolve({ continueCursor: null, isDone: true, page: args?.limit === undefined ? page : page.slice(0, args.limit) });
        },
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

        expect(result).toStrictEqual({ erased: ["usr_gone"], failed: [] });
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

        expect(result).toStrictEqual({ erased: ["usr_c"], failed: ["usr_a", "usr_b"] });
    });

    it("does not ask the auth layer when there are no memberships", async () => {
        const sweepPorts = ports([]);

        await expect(runAccountErasureSweep(pagedStore([], 10), sweepPorts)).resolves.toStrictEqual({ erased: [], failed: [] });
        expect(sweepPorts.existingUserIds).not.toHaveBeenCalled();
    });

    it("leaves a user alone whose only memberships are owner memberships an operator removal kept", async () => {
        const sweepPorts = ports([]);
        const store = markedStore(
            [
                { _id: "m_kept", organizationId: "org_1", role: "owner", userId: "usr_removed" },
                { _id: "m_peer", organizationId: "org_1", role: "member", userId: "usr_peer" },
            ],
            ["m_kept"],
        );

        await expect(runAccountErasureSweep(store, { ...sweepPorts, existingUserIds: () => Promise.resolve(new Set(["usr_peer"])) })).resolves.toStrictEqual({
            erased: [],
            failed: [],
        });
        expect(sweepPorts.erase).not.toHaveBeenCalled();
    });

    it("still erases an unmarked owner membership, and a user with a kept one beside others", async () => {
        const sweepPorts = ports([]);
        const store = markedStore(
            [
                { _id: "m_unmarked", organizationId: "org_1", role: "owner", userId: "usr_gone" },
                { _id: "m_kept", organizationId: "org_2", role: "owner", userId: "usr_mixed" },
                { _id: "m_left", organizationId: "org_3", role: "member", userId: "usr_mixed" },
            ],
            ["m_kept"],
        );

        await expect(runAccountErasureSweep(store, sweepPorts)).resolves.toStrictEqual({ erased: ["usr_gone", "usr_mixed"], failed: [] });
    });

    it("erases a kept ownership once support has given the organization another owner", async () => {
        const sweepPorts = ports([]);
        const store = markedStore(
            [
                { _id: "m_kept", organizationId: "org_1", role: "owner", userId: "usr_removed" },
                { _id: "m_new", organizationId: "org_1", role: "owner", userId: "usr_new_owner" },
            ],
            ["m_kept"],
        );

        await expect(
            runAccountErasureSweep(store, { ...sweepPorts, existingUserIds: () => Promise.resolve(new Set(["usr_new_owner"])) }),
        ).resolves.toStrictEqual({
            erased: ["usr_removed"],
            failed: [],
        });
    });

    it("does not count kept ownerships against the per-tick cap", async () => {
        const kept = Array.from({ length: MAX_ERASURES_PER_TICK + 5 }, (_, index) => {
            return { _id: `m_kept_${String(index)}`, organizationId: `org_${String(index)}`, role: "owner", userId: `usr_kept_${String(index)}` };
        });
        const sweepPorts = ports([]);
        const store = markedStore(
            [...kept, { _id: "m_real", organizationId: "org_x", role: "member", userId: "usr_real" }],
            kept.map((row) => row._id),
        );

        await expect(runAccountErasureSweep(store, sweepPorts)).resolves.toStrictEqual({ erased: ["usr_real"], failed: [] });
    });
});
