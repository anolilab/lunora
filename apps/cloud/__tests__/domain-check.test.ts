import { describe, expect, it } from "vitest";

import { FAILURES_BEFORE_UNVERIFIED, reconcileDomain } from "../src/domains/check";
import { expireUnverifiedDomains, projectPlatformTargets, runDomainSweep } from "../src/domains/sweep";
import type { DnsAnswer } from "../src/domains/verify";
import type { ControlPlaneDatabase } from "../src/store";

const NOW = 1_700_000_000_000;
const APP = "lunora.app";
/** A box domain outside the apex, as `LUNORA_BOX_DOMAIN` may set it. */
const BOX_DOMAIN = "boxes.example.net";

describe(reconcileDomain, () => {
    it("announces the first passing check and stamps verifiedAt", () => {
        expect(reconcileDomain({}, true, NOW)).toStrictEqual({ patch: { failedChecks: 0, verifiedAt: NOW }, transition: "domain.verified" });
    });

    it("stays quiet while a verified domain keeps passing", () => {
        expect(reconcileDomain({ verifiedAt: 5 }, true, NOW)).toStrictEqual({ patch: { failedChecks: 0, verifiedAt: 5 }, transition: null });
    });

    it("tolerates a single failed check, so one flaky lookup is not an outage", () => {
        expect(reconcileDomain({ verifiedAt: 5 }, false, NOW)).toStrictEqual({ patch: { failedChecks: 1, verifiedAt: 5 }, transition: null });
    });

    it("announces domain.failed and clears verifiedAt after the threshold of misses in a row", () => {
        const outcome = reconcileDomain({ failedChecks: FAILURES_BEFORE_UNVERIFIED - 1, verifiedAt: 5 }, false, NOW);

        expect(outcome.transition).toBe("domain.failed");
        expect(outcome.patch).toStrictEqual({ failedChecks: 0, verifiedAt: null });
    });

    it("resets the miss count when a check passes again", () => {
        expect(reconcileDomain({ failedChecks: 1, verifiedAt: 5 }, true, NOW)).toStrictEqual({ patch: { failedChecks: 0, verifiedAt: 5 }, transition: null });
    });

    it("leaves a domain that was never verified quiet while it is pending", () => {
        expect(reconcileDomain({}, false, NOW)).toStrictEqual({ patch: { failedChecks: 0 }, transition: null });
    });
});

type Row = Record<string, unknown> & { _id: string };

/** Minimal control-plane store: exact-match `where`, sorted `orderBy`, recording writes. */
const fakeDatabase = (tables: Record<string, Row[]>): ControlPlaneDatabase & { rows: Record<string, Row[]> } => {
    return {
        delete: () => Promise.resolve(undefined),
        findMany: (table, args) => {
            const [sortKey] = args?.orderBy?.[0] ? Object.entries(args.orderBy[0]) : [];
            const direction = sortKey?.[1] === "desc" ? -1 : 1;
            const rows = (tables[table] ?? [])
                .filter((row) => Object.entries(args?.where ?? {}).every(([key, value]) => row[key] === value))
                .toSorted((a, b) => (sortKey ? (Number(a[sortKey[0]]) - Number(b[sortKey[0]])) * direction : 0));

            return Promise.resolve({ page: args?.limit === undefined ? rows : rows.slice(0, args.limit) });
        },
        insert: (table, document) => {
            // eslint-disable-next-line no-param-reassign -- the fake's state is the record the test passed in and reads back
            tables[table] ??= [];
            const rows = tables[table];
            rows.push({ _id: `${table}_${String(rows.length)}`, ...document });

            return Promise.resolve(undefined);
        },
        patch: (table, id, patch) => {
            const row = (tables[table] ?? []).find((candidate) => candidate._id === id);

            Object.assign(row ?? {}, patch);

            return Promise.resolve(undefined);
        },
        rows: tables,
    };
};

/** A DNS resolver that answers the TXT token and CNAME for each hostname it is told about. */
const resolverFor =
    (records: Record<string, DnsAnswer[]>) =>
    (name: string): Promise<DnsAnswer[]> =>
        Promise.resolve(records[name] ?? []);

/** Every project on the cell apex, as a `cloudflare-wfp` placement answers. */
const apexTargets = async (): Promise<string[]> => [APP];

const txt = (token: string): DnsAnswer[] => [{ data: `"${token}"`, type: 16 }];
const cname = (target: string): DnsAnswer[] => [{ data: `${target}.`, type: 5 }];

const domainRow = (overrides: Row): Row => {
    return {
        createdAt: 1,
        hostname: "app.example.com",
        organizationId: "org",
        projectId: "proj",
        txtToken: "tok",
        updatedAt: 1,
        ...overrides,
    };
};

describe(expireUnverifiedDomains, () => {
    const DAY = 24 * 60 * 60 * 1000;

    /** A store whose `delete` removes the row, so the test reads back what survived. */
    const expiringDatabase = (rows: Row[]) => {
        const remaining = [...rows];
        const database: ControlPlaneDatabase = {
            delete: (_table, id) => {
                const index = remaining.findIndex((row) => row._id === id);

                if (index !== -1) {
                    remaining.splice(index, 1);
                }

                return Promise.resolve(undefined);
            },
            findMany: () => Promise.resolve({ page: [...remaining] }),
            insert: () => Promise.resolve(undefined),
            patch: () => Promise.resolve(undefined),
        };

        return { database, remaining };
    };

    it("removes a domain still unverified after seven days, and keeps a verified one and a recent one", async () => {
        const { database, remaining } = expiringDatabase([
            { _id: "stale", createdAt: NOW - 8 * DAY, hostname: "stale.example.com", verifiedAt: null },
            { _id: "verified", createdAt: NOW - 30 * DAY, hostname: "verified.example.com", verifiedAt: NOW - 20 * DAY },
            { _id: "recent", createdAt: NOW - 2 * DAY, hostname: "recent.example.com", verifiedAt: null },
        ]);

        await expect(expireUnverifiedDomains(database, { now: NOW })).resolves.toStrictEqual({ expired: 1 });
        expect(remaining.map((row) => row._id)).toStrictEqual(["verified", "recent"]);
    });

    it("keeps an old unverified domain that already holds a certificate", async () => {
        const { database, remaining } = expiringDatabase([
            { _id: "certified", createdAt: NOW - 8 * DAY, customHostnameId: "chn_1", hostname: "c.example.com", verifiedAt: null },
        ]);

        await expect(expireUnverifiedDomains(database, { now: NOW })).resolves.toStrictEqual({ expired: 0 });
        expect(remaining.map((row) => row._id)).toStrictEqual(["certified"]);
    });
});

describe(runDomainSweep, () => {
    it("verifies a pending domain whose records now point at the platform, and announces it", async () => {
        const database = fakeDatabase({
            domains: [domainRow({ _id: "dom_1" })],
            notificationChannels: [{ _id: "chan", enabled: true, events: ["domain.verified"], kind: "slack", organizationId: "org" }],
            projects: [{ _id: "proj", name: "Acme", organizationId: "org" }],
        });
        const resolve = resolverFor({
            "_lunora.app.example.com": txt("tok"),
            "app.example.com": cname(`proj.${APP}`),
        });

        const result = await runDomainSweep(database, { now: NOW, platformTargets: apexTargets, resolve });

        expect(result).toStrictEqual({ checked: 1, failed: 0, verified: 1 });
        expect(database.rows["domains"]?.[0]).toMatchObject({ failedChecks: 0, lastCheckedAt: NOW, updatedAt: NOW, verifiedAt: NOW });
        expect(database.rows["notificationDeliveries"]).toMatchObject([
            {
                body: 'Domain verified for "Acme" on Lunora Cloud.\napp.example.com now serves the app.',
                channelId: "chan",
                event: "domain.verified",
                status: "pending",
            },
        ]);
    });

    it("marks a verified domain failed only after the threshold of missed checks, then announces it", async () => {
        const database = fakeDatabase({
            domains: [domainRow({ _id: "dom_1", verifiedAt: 5 })],
            notificationChannels: [{ _id: "chan", enabled: true, events: ["domain.failed"], kind: "slack", organizationId: "org" }],
            projects: [{ _id: "proj", name: "Acme", organizationId: "org" }],
        });
        const resolve = resolverFor({});

        await runDomainSweep(database, { now: NOW, platformTargets: apexTargets, resolve });

        expect(database.rows["domains"]?.[0]).toMatchObject({ failedChecks: 1, lastCheckedAt: NOW, verifiedAt: 5 });
        expect(database.rows["notificationDeliveries"] ?? []).toHaveLength(0);

        const second = await runDomainSweep(database, { now: NOW + 1000, platformTargets: apexTargets, resolve });

        expect(second).toStrictEqual({ checked: 1, failed: 1, verified: 0 });
        expect(database.rows["domains"]?.[0]).toMatchObject({ failedChecks: 0, verifiedAt: null });
        expect(database.rows["notificationDeliveries"]).toMatchObject([{ event: "domain.failed", status: "pending" }]);
    });

    /**
     * A box answers a custom domain on its own hostname, so its domains CNAME there. Checked
     * against the cell apex they missed every tick and lost their verified status on the second.
     */
    it("keeps a box-hosted domain that points at its box verified across repeated checks", async () => {
        const database = fakeDatabase({
            boxes: [{ _id: "box_1", organizationId: "org", slug: "edge-1", status: "online" }],
            domains: [domainRow({ _id: "dom_1", verifiedAt: 5 })],
            projects: [{ _id: "proj", name: "Acme", organizationId: "org", placementRef: "box_1", target: "celld-vps" }],
        });
        const read = {
            get: async (table: string, id: string): Promise<unknown> => database.rows[table]?.find((row) => row._id === id) ?? null,
        };
        const platformTargets = projectPlatformTargets(read, (placement) => {
            return {
                domains: {
                    issue: async () => undefined,
                    platformTargets: () => ("host" in placement && "slug" in placement.host ? [`${placement.host.slug}.${BOX_DOMAIN}`] : [APP]),
                },
            };
        });
        const resolve = resolverFor({
            "_lunora.app.example.com": txt("tok"),
            "app.example.com": cname(`edge-1.${BOX_DOMAIN}`),
        });

        await runDomainSweep(database, { now: NOW, platformTargets, resolve });
        await runDomainSweep(database, { now: NOW + 1000, platformTargets, resolve });

        expect(database.rows["domains"]?.[0]).toMatchObject({ failedChecks: 0, verifiedAt: 5 });
    });

    it("leaves a domain whose project has no reachable placement unjudged", async () => {
        const database = fakeDatabase({ domains: [domainRow({ _id: "dom_1", verifiedAt: 5 })] });

        await runDomainSweep(database, { now: NOW, platformTargets: async () => undefined, resolve: resolverFor({}) });
        await runDomainSweep(database, { now: NOW + 1000, platformTargets: async () => undefined, resolve: resolverFor({}) });

        expect(database.rows["domains"]?.[0]).toMatchObject({ updatedAt: NOW + 1000, verifiedAt: 5 });
        expect(database.rows["domains"]?.[0]?.["failedChecks"]).toBeUndefined();
    });
});
