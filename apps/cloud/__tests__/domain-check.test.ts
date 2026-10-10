import { describe, expect, it } from "vitest";

import { FAILURES_BEFORE_UNVERIFIED, reconcileDomain } from "../src/domains/check";
import { runDomainSweep } from "../src/domains/sweep";
import type { DnsAnswer } from "../src/domains/verify";
import type { ControlPlaneDatabase } from "../src/store";

const NOW = 1_700_000_000_000;
const APP = "lunora.app";

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
const fakeDatabase = (tables: Record<string, Row[]>): ControlPlaneDatabase & { rows: Record<string, Row[]> } => ({
    delete: () => Promise.resolve(undefined),
    findMany: (table, args) => {
        const [sortKey] = args?.orderBy?.[0] ? Object.entries(args.orderBy[0]) : [];
        const rows = (tables[table] ?? [])
            .filter((row) => Object.entries(args?.where ?? {}).every(([key, value]) => row[key] === value))
            .toSorted((a, b) => (sortKey ? (Number(a[sortKey[0]]) - Number(b[sortKey[0]])) * (sortKey[1] === "desc" ? -1 : 1) : 0));

        return Promise.resolve({ page: args?.limit === undefined ? rows : rows.slice(0, args.limit) });
    },
    insert: (table, document) => {
        (tables[table] ??= []).push({ _id: `${table}_${String((tables[table] ?? []).length)}`, ...document });

        return Promise.resolve(undefined);
    },
    patch: (id, patch, table) => {
        const row = (tables[table ?? ""] ?? []).find((candidate) => candidate._id === id);

        Object.assign(row ?? {}, patch);

        return Promise.resolve(undefined);
    },
    rows: tables,
});

/** A DNS resolver that answers the TXT token and CNAME for each hostname it is told about. */
const resolverFor =
    (records: Record<string, DnsAnswer[]>) =>
    (name: string): Promise<DnsAnswer[]> =>
        Promise.resolve(records[name] ?? []);

const txt = (token: string): DnsAnswer[] => [{ data: `"${token}"`, type: 16 }];
const cname = (target: string): DnsAnswer[] => [{ data: `${target}.`, type: 5 }];

const domainRow = (overrides: Row): Row => ({
    createdAt: 1,
    hostname: "app.example.com",
    organizationId: "org",
    projectId: "proj",
    txtToken: "tok",
    updatedAt: 1,
    ...overrides,
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

        const result = await runDomainSweep(database, { appDomain: APP, now: NOW, resolve });

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

        await runDomainSweep(database, { appDomain: APP, now: NOW, resolve });
        expect(database.rows["domains"]?.[0]).toMatchObject({ failedChecks: 1, lastCheckedAt: NOW, verifiedAt: 5 });
        expect(database.rows["notificationDeliveries"] ?? []).toHaveLength(0);

        const second = await runDomainSweep(database, { appDomain: APP, now: NOW + 1000, resolve });

        expect(second).toStrictEqual({ checked: 1, failed: 1, verified: 0 });
        expect(database.rows["domains"]?.[0]).toMatchObject({ failedChecks: 0, verifiedAt: null });
        expect(database.rows["notificationDeliveries"]).toMatchObject([{ event: "domain.failed", status: "pending" }]);
    });
});
