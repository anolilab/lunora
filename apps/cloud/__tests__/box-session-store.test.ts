import { describe, expect, it } from "vitest";

import { loadBox, markOffline, recordHello, sessionBoxOf } from "../src/boxes/session-store";
import type { MemoryStore } from "./support/memory-store";
import { memoryStore } from "./support/memory-store";

const NOW = 1_700_000_000_000;

const HELLO = { resources: { cpus: 2, diskFreeMb: 40_960, memMb: 3891 }, versions: { celld: "v0.6.0", hostd: "v0.6.0" } };

/** A store whose first `boxes` read is followed by a revoke, as an owner's revoke landing between a session's read and its write. */
const revokedAfterFirstRead = (status: string): MemoryStore => {
    const store = memoryStore({ boxes: [{ _id: "box_1", organizationId: "org_1", publicKey: "pk", slug: "bslug000001", status }] });
    const { get } = store;
    let revoked = false;

    store.get = async (table, id) => {
        // A copy, as D1 answers: the revoke below must not reach the row already read.
        const row = { ...((await get(table, id)) as Record<string, unknown>) };

        if (!revoked) {
            revoked = true;
            await store.patch("boxes", "box_1", { revokedAt: NOW, status: "revoked" });
        }

        return row;
    };

    return store;
};

describe("box session writes against a concurrent revoke", () => {
    it("never leaves a box revoked during hello recorded as online", async () => {
        const store = revokedAfterFirstRead("offline");

        await recordHello(store, "box_1", HELLO as Parameters<typeof recordHello>[2], NOW);

        const box = await loadBox(store, "box_1");

        expect(box?.status).toBe("revoked");
        expect(sessionBoxOf(box)?.revoked).toBe(true);
    });

    it("never leaves a box revoked while going offline recorded as offline", async () => {
        const store = revokedAfterFirstRead("online");

        await markOffline(store, "box_1");

        const box = await loadBox(store, "box_1");

        expect(box?.status).toBe("revoked");
    });

    it("refuses the handshake for a row whose revocation a status write overtook", () => {
        expect(sessionBoxOf({ _id: "box_1", organizationId: "org_1", publicKey: "pk", revokedAt: NOW, slug: "s", status: "online" })?.revoked).toBe(true);
    });
});
