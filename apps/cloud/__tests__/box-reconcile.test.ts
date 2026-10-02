/* eslint-disable sonarjs/no-hardcoded-ip -- the records under test point at fixture addresses */
import { describe, expect, it } from "vitest";

import { runBoxSweep, sixHourlyTickRunsBoxSweep } from "../src/boxes/reconcile";
import type { CloudflareApi, DnsRecord } from "../src/cloudflare/api";
import { createHttpCloudflareApi, MAX_DNS_LIST_PAGES } from "../src/cloudflare/api";
import { DELETION_RETENTION_MS } from "../src/lib/deletion-retention";
import { boxSlugOfRecord, reconcileBoxDns } from "../src/targets/celld-vps/dns";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";

const DOMAIN = "boxes.test";
const NOW = 1_800_000_000_000;

const LIVE = "blive000001";
const REVOKED = "brevoked001";
const PURGED = "bpurged0001";

/** A zone in memory behind the DNS methods; `fail` makes a method throw for matching names. */
const memoryZone = (records: DnsRecord[], fail: { create?: string; delete?: string; list?: boolean } = {}) => {
    let sequence = 0;
    const writes: string[] = [];
    const api: CloudflareApi = {
        createCustomHostname: () => Promise.reject(new Error("unused")),
        createDnsRecord: ({ content, name, type }) => {
            if (fail.create !== undefined && name.includes(fail.create)) {
                return Promise.reject(new Error("rate limited"));
            }

            sequence += 1;
            records.push({ content, id: `new_${String(sequence)}`, name, type });
            writes.push(`create ${type} ${name} ${content}`);

            return Promise.resolve({ id: `new_${String(sequence)}` });
        },
        deleteDnsRecord: ({ id }) => {
            const index = records.findIndex((record) => record.id === id);
            const record = records[index];

            if (fail.delete !== undefined && record?.name.includes(fail.delete)) {
                return Promise.reject(new Error("upstream 500"));
            }

            writes.push(`delete ${record?.type ?? "?"} ${record?.name ?? "?"}`);
            records.splice(index, 1);

            return Promise.resolve();
        },
        exportD1Database: () => Promise.reject(new Error("unused")),
        listDnsRecords: ({ name }) => Promise.resolve(records.filter((record) => record.name === name)),
        listDnsRecordsUnder: ({ domain }) =>
            fail.list === true
                ? Promise.reject(new Error("cloudflare is down"))
                : Promise.resolve({ records: records.filter((record) => record.name.endsWith(`.${domain}`)), truncated: false }),
    };

    return { api, records, writes };
};

const record = (id: string, name: string, content = "203.0.113.9", type = "A"): DnsRecord => {
    return { content, id, name, type };
};

/** The records of a box with an IPv4 address, both names. */
const boxRecords = (slug: string, ip = "203.0.113.9"): DnsRecord[] => [
    record(`${slug}_w`, `*.${slug}.${DOMAIN}`, ip),
    record(`${slug}_a`, `${slug}.${DOMAIN}`, ip),
];

/** Records under the domain (or near it) that are not a box's, and must survive every pass. */
const FOREIGN: DnsRecord[] = [
    record("apex", DOMAIN),
    record("www", `www.${DOMAIN}`),
    record("txt", `${REVOKED}.${DOMAIN}`, "verification", "TXT"),
    record("deep", `x.y.${REVOKED}.${DOMAIN}`),
    record("cname", `*.${REVOKED}.${DOMAIN}`, "elsewhere.example", "CNAME"),
    record("other", `${REVOKED}.other.test`),
    record("shape", `Bnotaslug.${DOMAIN}`),
];

describe(boxSlugOfRecord, () => {
    it("claims only A/AAAA records at a box's two names", () => {
        expect(boxSlugOfRecord(record("1", `*.${LIVE}.${DOMAIN}`), DOMAIN)).toBe(LIVE);
        expect(boxSlugOfRecord(record("2", `${LIVE}.${DOMAIN}`.toUpperCase(), "2606:4700::1", "AAAA"), DOMAIN)).toBe(LIVE);

        for (const foreign of FOREIGN) {
            expect(boxSlugOfRecord(foreign, DOMAIN)).toBeNull();
        }
    });
});

describe(reconcileBoxDns, () => {
    it("deletes orphans, keeps live records, recreates missing ones and leaves everything else alone", async () => {
        const zone = memoryZone([...boxRecords(LIVE).slice(0, 1), ...boxRecords(REVOKED), ...boxRecords(PURGED), ...FOREIGN]);

        const result = await reconcileBoxDns(zone.api, {
            domain: DOMAIN,
            live: () => Promise.resolve([{ boxId: "box_live", ipv4: "203.0.113.9", slug: LIVE }]),
            maxWrites: 100,
            zoneId: "zone",
        });

        expect(zone.writes).toStrictEqual([
            `delete A *.${REVOKED}.${DOMAIN}`,
            `delete A ${REVOKED}.${DOMAIN}`,
            `delete A *.${PURGED}.${DOMAIN}`,
            `delete A ${PURGED}.${DOMAIN}`,
            `create A ${LIVE}.${DOMAIN} 203.0.113.9`,
        ]);
        expect(zone.records.filter((candidate) => FOREIGN.includes(candidate))).toStrictEqual(FOREIGN);
        expect(result).toMatchObject({ created: 1, deleted: 4, orphanFailures: [], writesCapped: false, zoneTruncated: false });
        expect(result.outcomes).toStrictEqual(new Map([["box_live", null]]));
    });

    it("repoints a live box whose address changed", async () => {
        const zone = memoryZone(boxRecords(LIVE, "198.51.100.7"));

        await reconcileBoxDns(zone.api, {
            domain: DOMAIN,
            live: () => Promise.resolve([{ boxId: "box_live", ipv4: "203.0.113.9", slug: LIVE }]),
            maxWrites: 100,
            zoneId: "zone",
        });

        expect(zone.records.map((candidate) => `${candidate.name} ${candidate.content}`).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            `*.${LIVE}.${DOMAIN} 203.0.113.9`,
            `${LIVE}.${DOMAIN} 203.0.113.9`,
        ]);
    });

    it("survives API errors: an orphan it could not delete is reported, a live box records why", async () => {
        const zone = memoryZone([...boxRecords(REVOKED)], { create: LIVE, delete: REVOKED });

        const result = await reconcileBoxDns(zone.api, {
            domain: DOMAIN,
            live: () => Promise.resolve([{ boxId: "box_live", ipv4: "203.0.113.9", slug: LIVE }]),
            maxWrites: 100,
            zoneId: "zone",
        });

        expect(result.orphanFailures).toHaveLength(2);
        expect(result.outcomes.get("box_live")).toContain("rate limited");
    });

    it("stops at its write budget", async () => {
        const zone = memoryZone([...boxRecords(REVOKED), ...boxRecords(PURGED)]);

        const result = await reconcileBoxDns(zone.api, { domain: DOMAIN, live: () => Promise.resolve([]), maxWrites: 3, zoneId: "zone" });

        expect(result).toMatchObject({ deleted: 3, writesCapped: true });
        expect(zone.records).toHaveLength(1);
    });

    it("creates nothing from a truncated listing, where a 'missing' record may sit on an unread page", async () => {
        const zone = memoryZone(boxRecords(REVOKED));
        const truncatedApi: CloudflareApi = {
            ...zone.api,
            listDnsRecordsUnder: async (input) => {
                return { ...(await zone.api.listDnsRecordsUnder(input)), truncated: true };
            },
        };

        const result = await reconcileBoxDns(truncatedApi, {
            domain: DOMAIN,
            live: () => Promise.resolve([{ boxId: "box_live", ipv4: "203.0.113.9", slug: LIVE }]),
            maxWrites: 100,
            zoneId: "zone",
        });

        expect(result).toMatchObject({ created: 0, deleted: 2, zoneTruncated: true });
    });
});

describe(runBoxSweep, () => {
    const box = (overrides: Record<string, unknown>) => {
        return { _id: "box_live", ipv4: "203.0.113.9", organizationId: "org_1", slug: LIVE, status: "online", ...overrides };
    };

    const sweep = (tables: Record<string, unknown[]>, zone: ReturnType<typeof memoryZone> | { unavailable: string }) => {
        const patches: { id: string; patch: Record<string, unknown> }[] = [];
        const closed: string[] = [];
        const logs: string[] = [];
        const run = runBoxSweep({
            retire: (boxId) => {
                closed.push(boxId);

                return Promise.resolve(null);
            },
            database: fakeControlPlaneDb(tables, {
                patch: (id, patch) => {
                    patches.push({ id, patch });

                    return Promise.resolve();
                },
            }),
            dns: "unavailable" in zone ? zone : { api: zone.api, domain: DOMAIN, zoneId: "zone" },
            log: (line) => {
                logs.push(line);
            },
            now: NOW,
        });

        return { closed, logs, patches, run };
    };

    it("retires the boxes of an organization due for erasure: revoked, disconnected, its records gone in the same pass", async () => {
        const zone = memoryZone([...boxRecords(LIVE), ...boxRecords(PURGED)]);
        const { closed, patches, run } = sweep(
            {
                boxes: [
                    box({}),
                    box({ _id: "box_erased", organizationId: "org_gone", slug: PURGED }),
                    box({ _id: "box_old", organizationId: "org_gone", slug: REVOKED, status: "revoked" }),
                ],
                organizations: [
                    { _id: "org_1" },
                    { _id: "org_gone", deletionRequestedAt: NOW - DELETION_RETENTION_MS - 1 },
                    { _id: "org_grace", deletionRequestedAt: NOW - DELETION_RETENTION_MS + 60_000 },
                ],
            },
            zone,
        );

        await expect(run).resolves.toMatchObject({ dns: { created: 0, deleted: 2 }, retired: 1 });
        expect(patches).toStrictEqual([{ id: "box_erased", patch: { revokedAt: NOW, status: "revoked" } }]);
        expect(closed).toStrictEqual(["box_erased"]);
        expect(zone.records.map((candidate) => candidate.name)).toStrictEqual([`*.${LIVE}.${DOMAIN}`, `${LIVE}.${DOMAIN}`]);
    });

    it("keeps the records of a box enrolled while the sweep runs", async () => {
        const fresh = "bfresh00001";
        const zone = memoryZone([...boxRecords(LIVE)]);
        const boxes: Record<string, unknown>[] = [box({})];
        const { listDnsRecordsUnder } = zone.api;

        // Enrolment lands after the sweep's first read of the boxes and before the
        // zone is listed: the row first, then its records — as the enrol route does.
        zone.api.listDnsRecordsUnder = (input) => {
            boxes.push(box({ _id: "box_fresh", slug: fresh }));
            zone.records.push(...boxRecords(fresh));

            return listDnsRecordsUnder(input);
        };

        const { run } = sweep({ boxes, organizations: [] }, zone);

        await expect(run).resolves.toMatchObject({ dns: { deleted: 0 } });
        expect(zone.records.map((candidate) => candidate.name)).toStrictEqual([
            `*.${LIVE}.${DOMAIN}`,
            `${LIVE}.${DOMAIN}`,
            `*.${fresh}.${DOMAIN}`,
            `${fresh}.${DOMAIN}`,
        ]);
    });

    it("keeps a box in its organization's grace window untouched", async () => {
        const zone = memoryZone(boxRecords(LIVE));
        const { closed, patches, run } = sweep(
            { boxes: [box({ organizationId: "org_grace" })], organizations: [{ _id: "org_grace", deletionRequestedAt: NOW - 1000 }] },
            zone,
        );

        await expect(run).resolves.toMatchObject({ retired: 0 });
        expect(closed).toStrictEqual([]);
        expect(patches).toStrictEqual([]);
        expect(zone.writes).toStrictEqual([]);
    });

    it("records a DNS outcome only when it changed", async () => {
        const zone = memoryZone([], { create: LIVE });
        const { patches, run } = sweep(
            { boxes: [box({ _id: "box_live" }), box({ _id: "box_ok", dnsError: "old failure", ipv4: undefined, slug: "bok00000001" })], organizations: [] },
            zone,
        );

        await run;

        expect(patches).toStrictEqual([
            { id: "box_live", patch: { dnsError: expect.stringContaining("rate limited") as string } },
            { id: "box_ok", patch: { dnsError: null } },
        ]);
    });

    it("still retires boxes without the box zone configured, and says why it skipped the zone", async () => {
        const { closed, logs, run } = sweep(
            { boxes: [box({ organizationId: "org_gone" })], organizations: [{ _id: "org_gone", deletionRequestedAt: 1 }] },
            { unavailable: "box DNS is not configured" },
        );

        await expect(run).resolves.toStrictEqual({ retired: 1 });
        expect(closed).toStrictEqual(["box_live"]);
        expect(logs).toStrictEqual(["[boxes] box DNS reconcile skipped: box DNS is not configured"]);
    });

    it("logs and returns when the zone cannot be listed, and a failed session close does not stop it", async () => {
        const zone = memoryZone([], { list: true });
        const logs: string[] = [];

        await expect(
            runBoxSweep({
                retire: () => Promise.resolve("no such object"),
                database: fakeControlPlaneDb({ boxes: [box({ organizationId: "org_gone" })], organizations: [{ _id: "org_gone", deletionRequestedAt: 1 }] }),
                dns: { api: zone.api, domain: DOMAIN, zoneId: "zone" },
                log: (line) => {
                    logs.push(line);
                },
                now: NOW,
            }),
        ).resolves.toStrictEqual({ retired: 1 });
        expect(logs).toStrictEqual([
            "[boxes] could not close the session of box box_live: no such object",
            "[boxes] box DNS reconcile failed: cloudflare is down",
        ]);
    });
});

describe("listing the box sub-domain over HTTP", () => {
    it("filters by name suffix and follows every page", async () => {
        const urls: string[] = [];
        const api = createHttpCloudflareApi({
            accountId: "acc",
            apiToken: "token",
            baseUrl: "https://api.test/client/v4",
            fetch: (input) => {
                const url = input instanceof Request ? input.url : input.toString();
                const page = Number(new URL(url).searchParams.get("page"));

                urls.push(url);

                return Promise.resolve(
                    Response.json({ result: [record(`r${String(page)}`, `b${String(page)}.${DOMAIN}`)], result_info: { total_pages: 2 }, success: true }),
                );
            },
        });

        await expect(api.listDnsRecordsUnder({ domain: DOMAIN, zoneId: "z" })).resolves.toStrictEqual({
            records: [record("r1", `b1.${DOMAIN}`), record("r2", `b2.${DOMAIN}`)],
            truncated: false,
        });
        expect(urls).toStrictEqual([
            "https://api.test/client/v4/zones/z/dns_records?name.endswith=.boxes.test&per_page=100&page=1",
            "https://api.test/client/v4/zones/z/dns_records?name.endswith=.boxes.test&per_page=100&page=2",
        ]);
    });

    it("stops at its page bound and says the listing is truncated", async () => {
        let calls = 0;
        const api = createHttpCloudflareApi({
            accountId: "acc",
            apiToken: "token",
            fetch: () => {
                calls += 1;

                return Promise.resolve(Response.json({ result: [], result_info: { total_pages: 10_000 }, success: true }));
            },
        });

        await expect(api.listDnsRecordsUnder({ domain: DOMAIN, zoneId: "z" })).resolves.toStrictEqual({ records: [], truncated: true });
        expect(calls).toBe(MAX_DNS_LIST_PAGES);
    });

    it("throws on an API error rather than reporting an empty zone", async () => {
        const api = createHttpCloudflareApi({
            accountId: "acc",
            apiToken: "token",
            fetch: () => Promise.resolve(Response.json({ errors: [{ message: "Authentication error" }], success: false }, { status: 403 })),
        });

        await expect(api.listDnsRecordsUnder({ domain: DOMAIN, zoneId: "z" })).rejects.toThrow("Authentication error");
    });
});

describe(sixHourlyTickRunsBoxSweep, () => {
    it("hands the box sweep to the six-hourly invocation on the hours both triggers fire", () => {
        expect([0, 6, 12, 18].map((hour) => sixHourlyTickRunsBoxSweep(Date.UTC(2026, 9, 2, hour)))).toStrictEqual([true, true, true, true]);
        expect([1, 5, 7, 23].map((hour) => sixHourlyTickRunsBoxSweep(Date.UTC(2026, 9, 2, hour)))).toStrictEqual([false, false, false, false]);
    });
});
