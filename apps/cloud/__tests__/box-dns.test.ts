/* eslint-disable sonarjs/no-hardcoded-ip -- the records under test point at fixture addresses */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudflareApi, DnsRecord } from "../src/cloudflare/api";
import { createHttpCloudflareApi } from "../src/cloudflare/api";
import { handleBoxEnrolRoute, handleBoxRevokeRoute } from "../src/deploy/routes/boxes";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { boxDnsFromEnv, removeBoxDns, syncBoxDns } from "../src/targets/celld-vps/dns";

/** A zone held in memory behind the {@link CloudflareApi} DNS methods. */
const memoryZone = (records: DnsRecord[] = []) => {
    let sequence = 0;
    const writes: string[] = [];
    const api: CloudflareApi = {
        createCustomHostname: () => Promise.reject(new Error("unused")),
        createDnsRecord: ({ content, name, type }) => {
            sequence += 1;
            records.push({ content, id: `rec_${String(sequence)}`, name, type });
            writes.push(`create ${type} ${name} ${content}`);

            return Promise.resolve({ id: `rec_${String(sequence)}` });
        },
        deleteDnsRecord: ({ id }) => {
            const index = records.findIndex((record) => record.id === id);

            writes.push(`delete ${records[index]?.type ?? "?"} ${records[index]?.name ?? "?"}`);
            records.splice(index, 1);

            return Promise.resolve();
        },
        exportD1Database: () => Promise.reject(new Error("unused")),
        listDnsRecords: ({ name }) => Promise.resolve(records.filter((record) => record.name === name)),
    };

    return { api, records, writes };
};

const TARGET = { domain: "boxes.test", ipv4: "203.0.113.9", ipv6: "2606:4700::1111", slug: "bslug000001", zoneId: "zone_1" };

describe("box DNS", () => {
    it("writes A and AAAA records for the box's wildcard and its own name, once", async () => {
        const zone = memoryZone();

        await syncBoxDns(zone.api, TARGET);
        await syncBoxDns(zone.api, TARGET);

        expect(zone.writes).toStrictEqual([
            "create A *.bslug000001.boxes.test 203.0.113.9",
            "create AAAA *.bslug000001.boxes.test 2606:4700::1111",
            "create A bslug000001.boxes.test 203.0.113.9",
            "create AAAA bslug000001.boxes.test 2606:4700::1111",
        ]);
    });

    it("replaces a record whose address changed, and drops the family the box no longer has", async () => {
        const zone = memoryZone();

        await syncBoxDns(zone.api, TARGET);
        zone.writes.length = 0;
        await syncBoxDns(zone.api, { ...TARGET, ipv4: "198.51.100.7", ipv6: undefined });

        expect(zone.writes).toStrictEqual([
            "delete A *.bslug000001.boxes.test",
            "delete AAAA *.bslug000001.boxes.test",
            "create A *.bslug000001.boxes.test 198.51.100.7",
            "delete A bslug000001.boxes.test",
            "delete AAAA bslug000001.boxes.test",
            "create A bslug000001.boxes.test 198.51.100.7",
        ]);
    });

    it("removes only the box's address records, and tolerates them being gone", async () => {
        const zone = memoryZone([{ content: "verification", id: "txt_1", name: "bslug000001.boxes.test", type: "TXT" }]);

        await syncBoxDns(zone.api, TARGET);
        await removeBoxDns(zone.api, TARGET);
        await removeBoxDns(zone.api, TARGET);

        expect(zone.records).toStrictEqual([{ content: "verification", id: "txt_1", name: "bslug000001.boxes.test", type: "TXT" }]);
    });

    it("says why it cannot write DNS rather than failing", () => {
        expect(boxDnsFromEnv({})).toStrictEqual({ unavailable: expect.stringContaining("LUNORA_BOX_ZONE_ID") as string });
        expect(boxDnsFromEnv({ LUNORA_BOX_ZONE_ID: "zone_1" })).toStrictEqual({ unavailable: expect.stringContaining("DNS:Edit") as string });
        expect(boxDnsFromEnv({ CLOUDFLARE_API_TOKEN: "t", LUNORA_BOX_ZONE_ID: "zone_1" })).toMatchObject({ domain: "boxes.lunora.app", zoneId: "zone_1" });
    });
});

describe("the Cloudflare DNS methods", () => {
    it("lists by exact name, creates DNS-only records, and deletes by id", async () => {
        const calls: { body?: unknown; method: string; url: string }[] = [];
        const api = createHttpCloudflareApi({
            accountId: "acc",
            apiToken: "token",
            baseUrl: "https://api.test/client/v4",
            fetch: (input, init) => {
                calls.push({
                    ...(init?.body === undefined ? {} : { body: JSON.parse(init.body as string) }),
                    method: init?.method ?? "GET",
                    url: input instanceof Request ? input.url : input.toString(),
                });

                return Promise.resolve(
                    Response.json({ result: init?.method === "GET" ? [{ content: "1.2.3.4", id: "r1", name: "x", type: "A" }] : { id: "r2" }, success: true }),
                );
            },
        });

        await expect(api.listDnsRecords({ name: "*.b.boxes.test", zoneId: "z" })).resolves.toStrictEqual([
            { content: "1.2.3.4", id: "r1", name: "x", type: "A" },
        ]);
        await expect(api.createDnsRecord({ content: "1.2.3.4", name: "*.b.boxes.test", type: "A", zoneId: "z" })).resolves.toStrictEqual({ id: "r2" });

        await api.deleteDnsRecord({ id: "r1", zoneId: "z" });

        expect(calls).toStrictEqual([
            { method: "GET", url: "https://api.test/client/v4/zones/z/dns_records?name=*.b.boxes.test&per_page=100" },
            {
                body: { content: "1.2.3.4", name: "*.b.boxes.test", proxied: false, ttl: 300, type: "A" },
                method: "POST",
                url: "https://api.test/client/v4/zones/z/dns_records",
            },
            { method: "DELETE", url: "https://api.test/client/v4/zones/z/dns_records/r1" },
        ]);
    });
});

describe("box routes write and remove DNS", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const contextWith = (result: unknown) => {
        const mutations: { args: Record<string, unknown> }[] = [];

        return {
            context: {
                runAction: () => Promise.reject(new Error("unused")),
                runMutation: <R>(_reference: unknown, args: Record<string, unknown> = {}) => {
                    mutations.push({ args });

                    return Promise.resolve(result as R);
                },
                runQuery: () => Promise.reject(new Error("unused")),
            } as NonNullable<RouterEnv["__lunoraCtx"]>,
            mutations,
        };
    };

    it("records on the box why its DNS could not be written, and still enrols it", async () => {
        const { context, mutations } = contextWith({ boxId: "box_1", created: true, ipv4: "203.0.113.9", organizationId: "org_1", slug: "bslug000001" });
        const response = await handleBoxEnrolRoute(
            new Request("https://cloud.test/v1/boxes/enrol", {
                body: JSON.stringify({
                    ipv4: "203.0.113.9",
                    publicKey: "k".repeat(43),
                    token: `lbe_${"0".repeat(64)}`,
                    versions: { caddy: "a", celld: "b", hostd: "c" },
                }),
                method: "POST",
            }),
            { __lunoraCtx: context },
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ boxId: "box_1", dnsError: expect.stringContaining("LUNORA_BOX_ZONE_ID") as string });
        expect(mutations[1]?.args).toStrictEqual({ boxId: "box_1", dnsError: expect.stringContaining("LUNORA_BOX_ZONE_ID") as string });
    });

    it("writes the records at enrolment and clears the row's DNS error", async () => {
        const requests: string[] = [];

        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(`${init?.method ?? "GET"} ${input instanceof Request ? input.url : input.toString()}`);

            return Promise.resolve(Response.json({ result: init?.method === "GET" ? [] : { id: "rec" }, success: true }));
        });

        const { context, mutations } = contextWith({ boxId: "box_1", created: true, ipv4: "203.0.113.9", organizationId: "org_1", slug: "bslug000001" });

        await handleBoxEnrolRoute(
            new Request("https://cloud.test/v1/boxes/enrol", {
                body: JSON.stringify({
                    ipv4: "203.0.113.9",
                    publicKey: "k".repeat(43),
                    token: `lbe_${"0".repeat(64)}`,
                    versions: { caddy: "a", celld: "b", hostd: "c" },
                }),
                method: "POST",
            }),
            { __lunoraCtx: context, CLOUDFLARE_API_TOKEN: "t", LUNORA_BOX_DOMAIN: "boxes.test", LUNORA_BOX_ZONE_ID: "zone_1" },
        );

        expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(2);
        expect(mutations[1]?.args).toStrictEqual({ boxId: "box_1", dnsError: null });
    });

    it("removes the records at revocation", async () => {
        const deleted: string[] = [];

        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === "DELETE") {
                deleted.push(input instanceof Request ? input.url : input.toString());
            }

            return Promise.resolve(
                Response.json({ result: init?.method === "GET" ? [{ content: "203.0.113.9", id: "rec_a", name: "n", type: "A" }] : {}, success: true }),
            );
        });

        const { context, mutations } = contextWith({ ipv4: "203.0.113.9", slug: "bslug000001" });
        const response = await handleBoxRevokeRoute(
            new Request("https://cloud.test/v1/boxes/revoke", { body: JSON.stringify({ id: "box_1", organizationId: "org_1" }), method: "POST" }),
            { __lunoraCtx: context, CLOUDFLARE_API_TOKEN: "t", LUNORA_BOX_DOMAIN: "boxes.test", LUNORA_BOX_ZONE_ID: "zone_1" },
        );

        await expect(response.json()).resolves.toStrictEqual({ ok: true, sessionClosed: false });
        expect(deleted).toHaveLength(2);
        expect(mutations[1]?.args).toStrictEqual({ boxId: "box_1", dnsError: null });
    });
});
