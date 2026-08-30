import { describe, expect, it, vi } from "vitest";

import type { ControlPlaneDatabase } from "../src/store";
import { ALERT_DRAIN_GRACE_MS, ALERT_DRAIN_MAX, runAlertDrain } from "../src/telemetry/alert-drain";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";

const now = 10_000_000;

const firingRow = (id: string, createdAt: number): Record<string, unknown> => {
    return { _id: id, body: "it broke", channel: "webhook", createdAt, destination: "https://hook.example", status: "firing", subject: `[Lunora] ${id}` };
};

const fakeDb = (rows: unknown[]): ControlPlaneDatabase => fakeControlPlaneDb({ alerts: rows });

describe(runAlertDrain, () => {
    it("delivers a firing alert once it is past the grace window", async () => {
        const { deliveries, skipped } = await runAlertDrain(fakeDb([firingRow("a1", now - ALERT_DRAIN_GRACE_MS - 1)]), { now });

        expect(skipped).toBe(0);
        expect(deliveries).toStrictEqual([{ body: "it broke", channel: "webhook", destination: "https://hook.example", id: "a1", subject: "[Lunora] a1" }]);
    });

    it("leaves a fresh alert alone, so the path that fired it can deliver it first", async () => {
        // This is the whole reason the grace exists: the ingest and sweep paths
        // insert and send inside one request. Draining a row they are still working
        // on would page the same person twice for one event.
        const { deliveries, skipped } = await runAlertDrain(fakeDb([firingRow("a1", now - 1000)]), { now });

        expect(deliveries).toStrictEqual([]);
        expect(skipped).toBe(1);
    });

    it("sends the oldest backlog first", async () => {
        const old = now - ALERT_DRAIN_GRACE_MS - 100_000;
        const { deliveries } = await runAlertDrain(fakeDb([firingRow("newer", old + 5000), firingRow("older", old)]), { now });

        expect(deliveries.map((delivery) => delivery.id)).toStrictEqual(["older", "newer"]);
    });

    it("reads only firing rows past the grace, oldest first, bounded", async () => {
        const findMany = vi.fn<ControlPlaneDatabase["findMany"]>(() => Promise.resolve({ page: [] }));

        await runAlertDrain(fakeControlPlaneDb({}, { findMany }), { now });

        // Ordering and the cutoff both belong in the query: filtering after an
        // unordered page lets a burst of in-grace rows fill it and starve the
        // oldest undelivered alerts, which is the backlog this sweep exists for.
        expect(findMany).toHaveBeenCalledWith("alerts", {
            limit: ALERT_DRAIN_MAX,
            orderBy: [{ createdAt: "asc" }],
            where: { createdAt: { lte: now - ALERT_DRAIN_GRACE_MS }, status: "firing" },
        });
    });
});
