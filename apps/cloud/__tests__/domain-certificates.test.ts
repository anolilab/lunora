import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/api.js";
import { recordCertificate, removalTarget, remove } from "../lunora/domains";
import { certificateBadge } from "../src/client/domains";
import type { CloudflareApi, CustomHostname } from "../src/cloudflare/api";
import { createHttpCloudflareApi } from "../src/cloudflare/api";
import { handleDomainRemoveRoute, handleDomainVerifyRoute } from "../src/deploy/routes/domains";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { MAX_CERTIFICATES_PER_TICK, runCertificateSweep } from "../src/domains/certificate-sweep";
import { issueCertificate, refreshCertificate, removeCertificate } from "../src/targets/cloudflare-wfp/certificates";
import { createCloudflareWfpDriver, createCloudflareWfpFleet, UNCONFIGURED_CERTIFICATE } from "../src/targets/cloudflare-wfp/driver";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import readJson from "./_helpers/read-json";
import { memoryStore } from "./support/memory-store";

/**
 * Custom-domain certificates on `cloudflare-wfp` (GAPS.md B1): a verified
 * domain gets a Cloudflare-for-SaaS custom hostname (and with it a DV
 * certificate) through the driver's `domains.onVerified`; the hourly sweep
 * follows it to `active`; removing the domain deletes it first. Every
 * Cloudflare call here is faked.
 */

const ZONE = "saas-zone";

/** A SaaS zone in memory, behind the REST port's custom-hostname methods. */
const memoryZone = (seed: CustomHostname[] = []) => {
    const hostnames = new Map(seed.map((hostname) => [hostname.id, hostname]));
    let next = 0;
    const unused = (): Promise<never> => Promise.reject(new Error("not used by this test"));
    const api: CloudflareApi = {
        createCustomHostname: ({ hostname }) => {
            next += 1;

            const created: CustomHostname = { errors: [], hostname, id: `ch_${String(next)}`, sslStatus: "initializing", status: "pending" };

            hostnames.set(created.id, created);

            return Promise.resolve(created);
        },
        createDnsRecord: unused,
        deleteCustomHostname: ({ id }) => Promise.resolve(hostnames.delete(id)),
        deleteDnsRecord: unused,
        exportD1Database: unused,
        findCustomHostname: ({ hostname }) => Promise.resolve([...hostnames.values()].find((candidate) => candidate.hostname === hostname) ?? null),
        getCustomHostname: ({ id }) => Promise.resolve(hostnames.get(id) ?? null),
        listDnsRecords: unused,
        listDnsRecordsUnder: unused,
    };

    return { api, hostnames, zone: { api, zoneId: ZONE } };
};

const hostnameRow = (overrides: Partial<CustomHostname> = {}): CustomHostname => {
    return { errors: [], hostname: "app.example.com", id: "ch_old", sslStatus: "pending_validation", status: "pending", ...overrides };
};

describe("issuing a certificate", () => {
    it("creates a custom hostname for a domain verified for the first time", async () => {
        const { hostnames, zone } = memoryZone();

        await expect(issueCertificate(zone, { hostname: "app.example.com" })).resolves.toStrictEqual({ customHostnameId: "ch_1", sslStatus: "initializing" });
        expect(hostnames.size).toBe(1);
    });

    it("never creates a second one: it re-reads the one the row names, or finds the hostname's", async () => {
        const { hostnames, zone } = memoryZone([hostnameRow({ sslStatus: "active" })]);

        await expect(issueCertificate(zone, { customHostnameId: "ch_old", hostname: "app.example.com" })).resolves.toStrictEqual({
            customHostnameId: "ch_old",
            sslStatus: "active",
        });
        // The row lost its id (a failed record), but the zone still has the hostname.
        await expect(issueCertificate(zone, { hostname: "app.example.com" })).resolves.toMatchObject({ customHostnameId: "ch_old" });
        expect(hostnames.size).toBe(1);
    });

    it("requests a new one when the hostname the row names was deleted", async () => {
        const { zone } = memoryZone();

        await expect(issueCertificate(zone, { customHostnameId: "ch_gone", hostname: "app.example.com" })).resolves.toMatchObject({ customHostnameId: "ch_1" });
    });

    it("carries the issuer's validation errors, capped", async () => {
        const { zone } = memoryZone([hostnameRow({ errors: ["CAA record forbids issuance", "x".repeat(600)] })]);
        const certificate = await refreshCertificate(zone, "ch_old");

        expect(certificate?.error?.startsWith("CAA record forbids issuance; x")).toBe(true);
        expect(certificate?.error?.length).toBe(256);
        await expect(refreshCertificate(zone, "ch_missing")).resolves.toBeNull();
    });

    it("removes the hostname, and is done when it is already gone", async () => {
        const { hostnames, zone } = memoryZone([hostnameRow()]);

        await removeCertificate(zone, "ch_old");
        await removeCertificate(zone, "ch_old");

        expect(hostnames.size).toBe(0);
    });
});

describe("the cloudflare-wfp driver's domain hooks", () => {
    const driverWith = (saasZone?: ReturnType<typeof memoryZone>["zone"]) =>
        createCloudflareWfpDriver({
            appDomain: "lunora.test",
            box: () => {
                throw new Error("unused");
            },
            cell: "default",
            dispatchNamespace: "ns",
            ...(saasZone === undefined ? {} : { saasZone }),
        });

    it("requests the certificate of a verified domain, and deletes it when the domain goes", async () => {
        const { hostnames, zone } = memoryZone();
        const { domains } = driverWith(zone);

        await expect(domains.onVerified?.({ hostname: "app.example.com" })).resolves.toStrictEqual({ customHostnameId: "ch_1", sslStatus: "initializing" });

        await domains.onRemoved?.({ customHostnameId: "ch_1", hostname: "app.example.com" });

        expect(hostnames.size).toBe(0);
    });

    it("says no certificate could be requested on a control plane without a SaaS zone", async () => {
        await expect(driverWith().domains.onVerified?.({ hostname: "app.example.com" })).resolves.toStrictEqual(UNCONFIGURED_CERTIFICATE);
    });

    it("lets the fleet refresh certificates only when it has a SaaS zone", async () => {
        const { zone } = memoryZone([hostnameRow({ sslStatus: "active" })]);

        expect(createCloudflareWfpFleet({ cell: "default" }).refreshCertificate).toBeUndefined();
        await expect(createCloudflareWfpFleet({ cell: "default", saasZone: zone }).refreshCertificate?.("ch_old")).resolves.toMatchObject({
            sslStatus: "active",
        });
    });
});

describe("the Cloudflare custom-hostname methods", () => {
    it("create a DV certificate over HTTP validation, look one up by hostname, read and delete by id", async () => {
        const calls: { body?: unknown; method: string; url: string }[] = [];
        const hostname = {
            hostname: "app.example.com",
            id: "ch_1",
            ssl: { status: "pending_validation", validation_errors: [{ message: "CAA" }] },
            status: "pending",
        };
        const api = createHttpCloudflareApi({
            accountId: "acc",
            apiToken: "token",
            baseUrl: "https://api.test/client/v4",
            fetch: (input, init) => {
                const url = input instanceof Request ? input.url : input.toString();

                calls.push({ ...(init?.body === undefined ? {} : { body: JSON.parse(init.body as string) }), method: init?.method ?? "GET", url });

                if (url.endsWith("/ch_gone")) {
                    return Promise.resolve(Response.json({ errors: [{ message: "not found" }], success: false }, { status: 404 }));
                }

                return Promise.resolve(Response.json({ result: url.includes("?hostname=") ? [hostname] : hostname, success: true }));
            },
        });
        const expected = { errors: ["CAA"], hostname: "app.example.com", id: "ch_1", sslStatus: "pending_validation", status: "pending" };

        await expect(api.createCustomHostname({ hostname: "app.example.com", zoneId: "z" })).resolves.toStrictEqual(expected);
        await expect(api.findCustomHostname({ hostname: "app.example.com", zoneId: "z" })).resolves.toStrictEqual(expected);
        await expect(api.getCustomHostname({ id: "ch_1", zoneId: "z" })).resolves.toStrictEqual(expected);
        await expect(api.getCustomHostname({ id: "ch_gone", zoneId: "z" })).resolves.toBeNull();
        await expect(api.deleteCustomHostname({ id: "ch_1", zoneId: "z" })).resolves.toBe(true);
        await expect(api.deleteCustomHostname({ id: "ch_gone", zoneId: "z" })).resolves.toBe(false);

        expect(calls[0]).toStrictEqual({
            body: { hostname: "app.example.com", ssl: { method: "http", type: "dv" } },
            method: "POST",
            url: "https://api.test/client/v4/zones/z/custom_hostnames",
        });
        expect(calls[1]?.url).toBe("https://api.test/client/v4/zones/z/custom_hostnames?hostname=app.example.com");
        expect(calls[4]).toStrictEqual({ method: "DELETE", url: "https://api.test/client/v4/zones/z/custom_hostnames/ch_1" });
    });
});

describe("domains.recordCertificate / removalTarget / remove", () => {
    const world = (domain: Record<string, unknown> = {}) => {
        return {
            domains: [{ _id: "dom_1", hostname: "app.example.com", organizationId: "org_1", projectId: "proj_1", ...domain }],
            members: [owner("org_1")],
        };
    };

    it("records a certificate, keeping its id and clearing an earlier error", async () => {
        const { ctx, ops } = makeCtx(world({ certificateError: "old" }));

        await recordCertificate.handler(ctx, { customHostnameId: "ch_1", id: "dom_1" as never, organizationId: "org_1" as never, sslStatus: "initializing" });

        expect(ops).toContainEqual({
            id: "dom_1",
            kind: "patch",
            patch: { certificateError: null, certificateStatus: "initializing", customHostnameId: "ch_1", updatedAt: ctx.now },
        });
    });

    it("answers what removal must release, to an owner only", async () => {
        const { ctx } = makeCtx(world({ customHostnameId: "ch_1" }));
        const member = makeCtx({ ...world(), members: [{ ...owner("org_1"), role: "member" }] }).ctx;

        await expect(removalTarget.handler(ctx, { id: "dom_1" as never, organizationId: "org_1" as never })).resolves.toStrictEqual({
            customHostnameId: "ch_1",
            hostname: "app.example.com",
            projectId: "proj_1",
        });
        await expect(removalTarget.handler(member, { id: "dom_1" as never, organizationId: "org_1" as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("are internal: a certificate is only released by the route that removes the domain", () => {
        expect(remove.visibility).toBe("internal");
        expect(removalTarget.visibility).toBe("internal");
        expect(recordCertificate.visibility).toBe("internal");
    });
});

describe("the domain routes", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** A wfp project in this cell, with a SaaS zone whose API is the stubbed global fetch. */
    const environment = (context: NonNullable<RouterEnv["__lunoraCtx"]>): RouterEnv => {
        return {
            __lunoraCtx: context,
            CLOUDFLARE_ACCOUNT_ID: "acc",
            CLOUDFLARE_API_TOKEN: "token",
            LUNORA_APP_DOMAIN: "lunora.test",
            LUNORA_SAAS_ZONE_ID: ZONE,
        };
    };

    const contextAnswering = (queries: Map<unknown, unknown>) => {
        const mutations: { args: Record<string, unknown>; reference: unknown }[] = [];
        const context = {
            runAction: () => Promise.reject(new Error("unused")),
            runMutation: (reference: unknown, args: Record<string, unknown> = {}) => {
                mutations.push({ args, reference });

                return Promise.resolve(null);
            },
            runQuery: (reference: unknown) =>
                queries.has(reference) ? Promise.resolve(queries.get(reference)) : Promise.reject(new Error("unexpected query")),
        } as unknown as NonNullable<RouterEnv["__lunoraCtx"]>;

        return { context, mutations };
    };

    const placement = { cellName: "default", target: "cloudflare-wfp" };

    it("requests a verified domain's certificate and records it", async () => {
        const { api } = await import("../lunora/_generated/api.js");
        const { context, mutations } = contextAnswering(
            new Map<unknown, unknown>([
                [api.domains.get, { hostname: "app.example.com", projectId: "proj_1", txtToken: "tok" }],
                [internal.projects.placement, placement],
            ]),
        );

        vi.stubGlobal("fetch", (input: Request | string | URL, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : input.toString();

            if (url.startsWith("https://cloudflare-dns.com/")) {
                const answer = url.includes("type=TXT") ? [{ data: '"tok"', type: 16 }] : [{ data: "lunora.test.", type: 5 }];

                return Promise.resolve(Response.json({ Answer: answer }));
            }

            if (url.includes("/custom_hostnames?hostname=")) {
                return Promise.resolve(Response.json({ result: [], success: true }));
            }

            expect(init?.method).toBe("POST");

            return Promise.resolve(
                Response.json({ result: { hostname: "app.example.com", id: "ch_9", ssl: { status: "initializing" }, status: "pending" }, success: true }),
            );
        });

        const response = await handleDomainVerifyRoute(
            new Request("https://cloud.test/v1/domains/verify", { body: JSON.stringify({ id: "dom_1", organizationId: "org_1" }), method: "POST" }),
            environment(context),
        );

        await expect(readJson(response)).resolves.toMatchObject({ certificate: { customHostnameId: "ch_9", sslStatus: "initializing" }, verified: true });
        expect(mutations.map(({ reference }) => reference)).toStrictEqual([internal.domains.markVerified, internal.domains.recordCertificate]);
        expect(mutations[1]?.args).toStrictEqual({ customHostnameId: "ch_9", id: "dom_1", organizationId: "org_1", sslStatus: "initializing" });
    });

    it("deletes the domain's custom hostname before the domain, and keeps the domain when that fails", async () => {
        const removal = new Map<unknown, unknown>([
            [internal.domains.removalTarget, { customHostnameId: "ch_1", hostname: "app.example.com", projectId: "proj_1" }],
            [internal.projects.placement, placement],
        ]);
        const request = (): Request =>
            new Request("https://cloud.test/v1/domains/remove", { body: JSON.stringify({ id: "dom_1", organizationId: "org_1" }), method: "POST" });
        const deletes: string[] = [];

        vi.stubGlobal("fetch", (input: Request | string | URL, init?: RequestInit) => {
            deletes.push(`${init?.method ?? "GET"} ${input instanceof Request ? input.url : input.toString()}`);

            return Promise.resolve(Response.json({ result: { id: "ch_1" }, success: true }));
        });

        const removed = contextAnswering(removal);

        await expect(handleDomainRemoveRoute(request(), environment(removed.context))).resolves.toMatchObject({ status: 200 });
        expect(deletes).toStrictEqual([`DELETE https://api.cloudflare.com/client/v4/zones/${ZONE}/custom_hostnames/ch_1`]);
        expect(removed.mutations.map(({ reference }) => reference)).toStrictEqual([internal.domains.remove]);

        vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ errors: [{ message: "upstream down" }], success: false }, { status: 500 })));

        const kept = contextAnswering(removal);
        const failed = await handleDomainRemoveRoute(request(), environment(kept.context));

        expect(failed.status).toBe(502);
        await expect(readJson(failed)).resolves.toMatchObject({ error: expect.stringContaining("upstream down") as unknown });
        expect(kept.mutations).toStrictEqual([]);
    });

    it("refuses before touching the certificate when the caller may not remove the domain", async () => {
        const refusal = Object.assign(new Error("forbidden"), { code: "FORBIDDEN", status: 403 });
        const context = {
            runAction: () => Promise.reject(new Error("unused")),
            runMutation: () => Promise.reject(new Error("must not remove")),
            runQuery: () => Promise.reject(refusal),
        } as unknown as NonNullable<RouterEnv["__lunoraCtx"]>;
        const calls = vi.fn<typeof fetch>();

        vi.stubGlobal("fetch", calls);

        const response = await handleDomainRemoveRoute(
            new Request("https://cloud.test/v1/domains/remove", { body: JSON.stringify({ id: "dom_1", organizationId: "org_1" }), method: "POST" }),
            environment(context),
        );

        expect(response.status).toBe(403);
        expect(calls).not.toHaveBeenCalled();
    });
});

describe(runCertificateSweep, () => {
    it("follows verified domains' certificates until they are active, and forgets one that vanished", async () => {
        const store = memoryStore({
            domains: [
                { _id: "dom_pending", customHostnameId: "ch_1", hostname: "a.example.com", updatedAt: 1, verifiedAt: 1 },
                { _id: "dom_gone", certificateStatus: "pending_validation", customHostnameId: "ch_2", hostname: "b.example.com", updatedAt: 2, verifiedAt: 1 },
                { _id: "dom_active", certificateStatus: "active", customHostnameId: "ch_3", hostname: "c.example.com", updatedAt: 3, verifiedAt: 1 },
                { _id: "dom_unverified", customHostnameId: "ch_4", hostname: "d.example.com", updatedAt: 4 },
            ],
        });
        const refreshed: string[] = [];
        const result = await runCertificateSweep({
            database: store,
            now: 100,
            refresh: (id) => {
                refreshed.push(id);

                return Promise.resolve(id === "ch_1" ? { customHostnameId: "ch_1", sslStatus: "active" } : null);
            },
        });

        expect(result).toStrictEqual({ checked: 2, failed: 0, issued: 1 });
        expect(refreshed).toStrictEqual(["ch_1", "ch_2"]);
        expect(store.tables["domains"]?.find((row) => row["_id"] === "dom_pending")).toMatchObject({ certificateError: null, certificateStatus: "active" });
        expect(store.tables["domains"]?.find((row) => row["_id"] === "dom_gone")).toMatchObject({ certificateStatus: "missing", customHostnameId: null });
    });

    it("reads a bounded batch a tick, and survives a failed read", async () => {
        const store = memoryStore({
            domains: Array.from({ length: MAX_CERTIFICATES_PER_TICK + 10 }, (_, index) => {
                return { _id: `dom_${String(index)}`, customHostnameId: `ch_${String(index)}`, hostname: "x.example.com", updatedAt: index, verifiedAt: 1 };
            }),
        });
        const result = await runCertificateSweep({ database: store, log: () => undefined, now: 100, refresh: () => Promise.reject(new Error("rate limited")) });

        expect(result).toStrictEqual({ checked: MAX_CERTIFICATES_PER_TICK, failed: MAX_CERTIFICATES_PER_TICK, issued: 0 });
    });
});

describe(certificateBadge, () => {
    it("shows nothing before a domain verifies, or when its target records no certificate", () => {
        expect(certificateBadge({ certificateStatus: "initializing" })).toBeNull();
        expect(certificateBadge({ verifiedAt: 1 })).toBeNull();
    });

    it("reads each certificate state", () => {
        expect(certificateBadge({ certificateStatus: "active", verifiedAt: 1 })).toStrictEqual({ label: "certificate active", tone: "success" });
        expect(certificateBadge({ certificateStatus: "pending_validation", verifiedAt: 1 })).toMatchObject({ label: "certificate pending", tone: "warning" });
        expect(certificateBadge({ certificateError: "LUNORA_SAAS_ZONE_ID is unset", certificateStatus: "unconfigured", verifiedAt: 1 })).toStrictEqual({
            detail: "LUNORA_SAAS_ZONE_ID is unset",
            label: "no certificate",
            tone: "neutral",
        });
        expect(certificateBadge({ certificateError: "CAA forbids it", certificateStatus: "failed", verifiedAt: 1 })).toStrictEqual({
            detail: "CAA forbids it",
            label: "certificate error",
            tone: "danger",
        });
    });
});
