import { describe, expect, it } from "vitest";

import { OUTDATED_ALERT_AFTER_MS, outdatedBoxHash, runOutdatedBoxAlerts } from "../src/boxes/outdated";
import { renderDeployAlert } from "../src/telemetry/alerts";
import { memoryStore } from "./support/memory-store";

const DAY = 24 * 60 * 60 * 1000;
const RELEASED_AT = 1_800_000_000_000;
const OLD = { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.0.0" };
const NEW = { caddy: "v2.11.6", celld: "v0.7.0", hostd: "1.1.0" };

const box = (overrides: Record<string, unknown>) => {
    return {
        _id: "box_old",
        createdAt: RELEASED_AT - 30 * DAY,
        enrolledAt: RELEASED_AT - 30 * DAY,
        name: "edge-1",
        organizationId: "org_1",
        slug: "bslug000001",
        status: "online",
        versions: OLD,
        ...overrides,
    };
};

const rule = (overrides: Record<string, unknown> = {}) => {
    return {
        _id: "rule_1",
        channel: "email",
        destination: "ops@example.com",
        enabled: true,
        name: "Ops",
        organizationId: "org_1",
        target: "deploy",
        ...overrides,
    };
};

const seed = (boxes: Record<string, unknown>[], rules: Record<string, unknown>[] = [rule()]) =>
    memoryStore({
        alertRules: rules,
        alerts: [],
        boxes,
        hostdReleases: [
            { _id: "r1", channel: "stable", createdAt: RELEASED_AT - 60 * DAY, releaseId: "hostd-v1_0_0", versions: OLD },
            { _id: "r2", channel: null, createdAt: RELEASED_AT, releaseId: "hostd-v1_1_0", versions: NEW },
            { _id: "r3", channel: "canary", createdAt: RELEASED_AT + DAY, releaseId: "hostd-v1_2_0", versions: { ...NEW, celld: "v0.8.0" } },
        ],
    });

describe(runOutdatedBoxAlerts, () => {
    it("fires the org's deploy rules once a box has run an older celld than the newest stable release for over a week", async () => {
        const store = seed([box({})]);

        await expect(runOutdatedBoxAlerts(store, { now: RELEASED_AT + OUTDATED_ALERT_AFTER_MS - 1 })).resolves.toStrictEqual({ fired: 0 });
        await expect(runOutdatedBoxAlerts(store, { now: RELEASED_AT + OUTDATED_ALERT_AFTER_MS + 1 })).resolves.toStrictEqual({ fired: 1 });

        expect(store.tables["alerts"]).toStrictEqual([
            expect.objectContaining({
                body: expect.stringContaining("celld v0.6.0") as string,
                channel: "email",
                destination: "ops@example.com",
                hash: outdatedBoxHash("box_old", "hostd-v1_1_0"),
                organizationId: "org_1",
                ruleId: "rule_1",
                status: "firing",
                subject: "[Lunora] Ops: edge-1 — box outdated",
                target: "deploy",
            }),
        ]);
    });

    it("fires once per box per release, not once per sweep", async () => {
        const store = seed([box({})]);
        const now = RELEASED_AT + 2 * OUTDATED_ALERT_AFTER_MS;

        await runOutdatedBoxAlerts(store, { now });

        await expect(runOutdatedBoxAlerts(store, { now: now + DAY })).resolves.toStrictEqual({ fired: 0 });
        expect(store.tables["alerts"]).toHaveLength(1);

        // A newer stable release the box also misses is a new finding.
        store.tables["hostdReleases"]?.push({ _id: "r4", createdAt: now, releaseId: "hostd-v1_3_0", versions: { ...NEW, celld: "v0.9.0" } });

        await expect(runOutdatedBoxAlerts(store, { now: now + OUTDATED_ALERT_AFTER_MS + 1 })).resolves.toStrictEqual({ fired: 1 });
        expect(store.tables["alerts"]?.map((alert) => alert["hash"])).toStrictEqual([
            outdatedBoxHash("box_old", "hostd-v1_1_0"),
            outdatedBoxHash("box_old", "hostd-v1_3_0"),
        ]);
    });

    it("counts a week from enrolment for a box enrolled on an old celld", async () => {
        const store = seed([box({ enrolledAt: RELEASED_AT + 5 * DAY })]);

        await expect(runOutdatedBoxAlerts(store, { now: RELEASED_AT + OUTDATED_ALERT_AFTER_MS + 1 })).resolves.toStrictEqual({ fired: 0 });
        await expect(runOutdatedBoxAlerts(store, { now: RELEASED_AT + 5 * DAY + OUTDATED_ALERT_AFTER_MS + 1 })).resolves.toStrictEqual({ fired: 1 });
    });

    it("leaves current, revoked and unreported boxes, canary-only releases and disabled rules alone", async () => {
        const now = RELEASED_AT + 4 * OUTDATED_ALERT_AFTER_MS;
        const store = seed(
            [
                box({ _id: "box_current", versions: NEW }),
                box({ _id: "box_revoked", status: "revoked" }),
                box({ _id: "box_unreported", versions: null }),
                box({ _id: "box_other_org", organizationId: "org_2" }),
            ],
            [rule(), rule({ _id: "rule_off", enabled: false, organizationId: "org_2" })],
        );

        await expect(runOutdatedBoxAlerts(store, { now })).resolves.toStrictEqual({ fired: 0 });
        await expect(runOutdatedBoxAlerts(memoryStore({ boxes: [box({})], hostdReleases: [] }), { now })).resolves.toStrictEqual({ fired: 0 });
    });

    it("renders the box's name and slug", () => {
        expect(renderDeployAlert({ name: "Ops" }, { detail: "behind", kind: "box", project: "edge-1", reference: "bslug000001" })).toStrictEqual({
            body: 'Box outdated for "edge-1" (bslug000001) on Lunora Cloud.\n\nbehind',
            subject: "[Lunora] Ops: edge-1 — box outdated",
        });
    });
});
