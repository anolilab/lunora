import { describe, expect, it } from "vitest";

import { loadBox, markOffline, recordHello, sessionBoxOf } from "../src/boxes/session-store";
import type { MemoryStore } from "./support/memory-store";
import { memoryStore } from "./support/memory-store";

const NOW = 1_700_000_000_000;

const HELLO = { resources: { diskFreeMb: 40_960, memMb: 3891 }, versions: { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.0.0" } };

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

        await recordHello(store, "box_1", HELLO, NOW);

        const box = await loadBox(store, "box_1");

        expect(box?.status).toBe("revoked");
        expect(sessionBoxOf(box)?.revoked).toBe(true);
    });

    it("never leaves a box revoked while going offline recorded as offline", async () => {
        const store = revokedAfterFirstRead("online");

        await markOffline(store, "box_1", () => false);

        const box = await loadBox(store, "box_1");

        expect(box?.status).toBe("revoked");
    });

    it("refuses the handshake for a row whose revocation a status write overtook", () => {
        expect(sessionBoxOf({ _id: "box_1", organizationId: "org_1", publicKey: "pk", revokedAt: NOW, slug: "s", status: "online" })?.revoked).toBe(true);
    });
});

describe("box going offline against a concurrent reconnect", () => {
    it("leaves a box online when a new session authenticated while the old one's read was in flight", async () => {
        const store = memoryStore({ boxes: [{ _id: "box_1", organizationId: "org_1", publicKey: "pk", slug: "bslug000001", status: "online" }] });
        const { get } = store;
        let reconnected = false;

        store.get = async (table, id) => {
            const row = { ...((await get(table, id)) as Record<string, unknown>) };

            if (!reconnected) {
                reconnected = true;
                await recordHello(store, "box_1", HELLO, NOW);
            }

            return row;
        };

        await markOffline(store, "box_1", () => reconnected);

        const box = await loadBox(store, "box_1");

        expect(box?.status).toBe("online");
    });
});

describe("box hello against a newer session's hello", () => {
    it("keeps the newer session's report when an older session's write lands after it", async () => {
        const store = memoryStore({ boxes: [{ _id: "box_1", organizationId: "org_1", publicKey: "pk", slug: "bslug000001", status: "offline" }] });
        const { patchIf } = store;
        const newer = { resources: { diskFreeMb: 1024, memMb: 512 }, versions: { caddy: "v2.11.6", celld: "v0.7.0", hostd: "1.1.0" } };
        let overtaken = false;

        // The older session's write is in flight when the newer one records its hello, and lands last.
        store.patchIf = async (table, id, args) => {
            if (!overtaken) {
                overtaken = true;
                await recordHello(store, "box_1", newer, NOW + 1000);
            }

            return patchIf(table, id, args);
        };

        await recordHello(store, "box_1", HELLO, NOW);

        const box = (await loadBox(store, "box_1")) as Record<string, unknown> | null;

        expect(overtaken).toBe(true);
        expect(box?.["lastSeenAt"]).toBe(NOW + 1000);
        expect(box?.["versions"]).toStrictEqual(newer.versions);
        expect(box?.["resources"]).toStrictEqual(newer.resources);
    });
});
