import { afterEach, describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/api.js";
import { recordCertificate, removalTarget, remove } from "../lunora/domains";
import { purgeDeleted } from "../lunora/organizations";
import { remove as removeProject } from "../lunora/projects";
import { certificateBadge } from "../src/client/domains";
import type { CloudflareApi, CustomHostname } from "../src/cloudflare/api";
import { createHttpCloudflareApi } from "../src/cloudflare/api";
import { handleDomainRemoveRoute, handleDomainVerifyRoute } from "../src/deploy/routes/domains";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { MAX_CERTIFICATES_PER_TICK, runCertificateSweep } from "../src/domains/certificate-sweep";
import type { RecordedCertificate } from "../src/domains/issuers";
import { localIssuer, requireIssuer } from "../src/domains/issuers";
import { issueCertificate, refreshCertificate, removeCertificate } from "../src/targets/cloudflare-wfp/certificates";
import { createCloudflareWfpDriver, createCloudflareWfpFleet, UNCONFIGURED_CERTIFICATE } from "../src/targets/cloudflare-wfp/driver";
import type { CertificateIssuer } from "../src/targets/driver";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import readJson from "./_helpers/read-json";
import { memoryStore } from "./support/memory-store";

/**
 * Custom-domain certificates on `cloudflare-wfp` (GAPS.md B1): a verified
 * domain gets a Cloudflare-for-SaaS custom hostname (and with it a DV
 * certificate) through the driver's `domains.issue`, recorded with its issuer;
 * the hourly sweep follows it to `active` through that issuer; removing the
 * domain deletes it first, through that issuer too. Every Cloudflare call here
 * is faked.
 */

const ZONE = "saas-zone";

/** Every table `organizations.purgeDeleted` reads, so the double answers each. */
const PURGED_TABLES = [
    "alertRuleState",
    "alertRules",
    "alerts",
    "aliasOwnership",
    "auditLog",
    "boxEnrolments",
    "boxes",
    "buildLogs",
    "builds",
    "cloudflareAccounts",
    "dashboards",
    "deployKeys",
    "githubInstallations",
    "incidents",
    "invitations",
    "issues",
    "members",
    "metricPoints",
    "observations",
    "overageDebits",
    "platformUsage",
    "projects",
    "secrets",
    "tenantLogs",
    "uptimeChecks",
    "uptimeState",
];

/** What a stubbed `fetch` is called with. */
type FetchInput = Request | string | URL;

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

        await expect(issueCertificate(zone, { hostname: "app.example.com" })).resolves.toStrictEqual({
            customHostnameId: "ch_1",
            scope: ZONE,
            sslStatus: "initializing",
        });
        expect(hostnames.size).toBe(1);
    });

    it("re-reads the custom hostname the row names, never creating a second one", async () => {
        const { hostnames, zone } = memoryZone([hostnameRow({ sslStatus: "active" })]);

        await expect(issueCertificate(zone, { customHostnameId: "ch_old", hostname: "app.example.com" })).resolves.toStrictEqual({
            customHostnameId: "ch_old",
            scope: ZONE,
            sslStatus: "active",
        });
        expect(hostnames.size).toBe(1);
    });

    it("refuses to adopt a custom hostname for the name that this row did not create", async () => {
        // Another row's — a removed domain's, still queued for release — or one created outside Lunora.
        const { hostnames, zone } = memoryZone([hostnameRow({ id: "ch_other", sslStatus: "active" })]);

        await expect(issueCertificate(zone, { hostname: "app.example.com" })).rejects.toMatchObject({
            code: "CONFLICT",
            message: expect.stringContaining("already holds a certificate for app.example.com that this domain did not request") as unknown,
        });
        // A row naming an id the zone holds for ANOTHER hostname is not handed that one either.
        await expect(issueCertificate(zone, { customHostnameId: "ch_other", hostname: "www.example.com" })).resolves.toMatchObject({
            customHostnameId: "ch_1",
        });
        expect([...hostnames.keys()]).toStrictEqual(["ch_other", "ch_1"]);
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

    it("issues the certificate of a verified domain in its zone, and its fleet releases it there", async () => {
        const { hostnames, zone } = memoryZone();

        await expect(driverWith(zone).domains.issue({ hostname: "app.example.com" })).resolves.toStrictEqual({
            customHostnameId: "ch_1",
            scope: ZONE,
            sslStatus: "initializing",
        });

        await createCloudflareWfpFleet({ cell: "default", saasZone: zone }).certificates?.release("ch_1");

        expect(hostnames.size).toBe(0);
    });

    it("says no certificate could be requested on a control plane without a SaaS zone", async () => {
        await expect(driverWith().domains.issue({ hostname: "app.example.com" })).resolves.toStrictEqual(UNCONFIGURED_CERTIFICATE);
    });

    it("gives the fleet a certificate issuer, scoped to its zone, only when it has a SaaS zone", async () => {
        const { zone } = memoryZone([hostnameRow({ sslStatus: "active" })]);
        const issuer = createCloudflareWfpFleet({ cell: "default", saasZone: zone }).certificates;

        expect(createCloudflareWfpFleet({ cell: "default" }).certificates).toBeUndefined();
        expect(issuer?.scope).toBe(ZONE);
        await expect(issuer?.refresh("ch_old")).resolves.toMatchObject({ sslStatus: "active" });
    });
});

describe(localIssuer, () => {
    const { zone } = memoryZone();
    const wfp = createCloudflareWfpFleet({ cell: "default", saasZone: zone });
    const fleetOf = (target: string) => (target === "cloudflare-wfp" ? wfp : undefined);

    it("finds the issuer recorded with a certificate, in its own scope only", () => {
        expect(localIssuer({ certificateIssuer: "cloudflare-wfp", certificateScope: ZONE }, fleetOf)).toBe(wfp.certificates);
        // Another cell's zone is that cell's control plane's to follow.
        expect(localIssuer({ certificateIssuer: "cloudflare-wfp", certificateScope: "other-zone" }, fleetOf)).toBeUndefined();
        expect(localIssuer({ certificateIssuer: "celld-vps", certificateScope: ZONE }, fleetOf)).toBeUndefined();
        expect(localIssuer({ certificateIssuer: null, certificateScope: null }, fleetOf)).toBeUndefined();
    });

    it("refuses, naming the issuer, a certificate this control plane cannot release", () => {
        expect(() => requireIssuer({ certificateIssuer: "cloudflare-wfp", certificateScope: "other-zone" }, fleetOf)).toThrow(
            "its certificate was issued by cloudflare-wfp (other-zone), which this control plane cannot reach",
        );
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

    it("records a certificate with its issuer, keeping its id and clearing an earlier error", async () => {
        const { ctx, ops } = makeCtx(world({ certificateError: "old" }));

        await recordCertificate.handler(ctx, {
            customHostnameId: "ch_1",
            id: "dom_1" as never,
            issuer: "cloudflare-wfp",
            organizationId: "org_1" as never,
            scope: ZONE,
            sslStatus: "initializing",
        });

        expect(ops).toContainEqual({
            id: "dom_1",
            kind: "patch",
            patch: {
                certificateError: null,
                certificateIssuer: "cloudflare-wfp",
                certificateScope: ZONE,
                certificateStatus: "initializing",
                customHostnameId: "ch_1",
                updatedAt: ctx.now,
            },
        });
    });

    it("refuses an issued certificate without its issuer: it could never be released", async () => {
        const { ctx } = makeCtx(world());

        await expect(
            recordCertificate.handler(ctx, { customHostnameId: "ch_1", id: "dom_1" as never, organizationId: "org_1" as never, sslStatus: "initializing" }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("answers what removal must release, with its issuer, to an owner only", async () => {
        const { ctx } = makeCtx(world({ certificateIssuer: "cloudflare-wfp", certificateScope: ZONE, customHostnameId: "ch_1" }));
        const member = makeCtx({ ...world(), members: [{ ...owner("org_1"), role: "member" }] }).ctx;

        await expect(removalTarget.handler(ctx, { id: "dom_1" as never, organizationId: "org_1" as never })).resolves.toStrictEqual({
            certificateIssuer: "cloudflare-wfp",
            certificateScope: ZONE,
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

        vi.stubGlobal("fetch", (input: FetchInput, init?: RequestInit) => {
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
        expect(mutations[1]?.args).toStrictEqual({
            customHostnameId: "ch_9",
            id: "dom_1",
            issuer: "cloudflare-wfp",
            organizationId: "org_1",
            scope: ZONE,
            sslStatus: "initializing",
        });
    });

    it("deletes the domain's custom hostname before the domain, and keeps the domain when that fails", async () => {
        const removal = new Map<unknown, unknown>([
            [
                internal.domains.removalTarget,
                { certificateIssuer: "cloudflare-wfp", certificateScope: ZONE, customHostnameId: "ch_1", hostname: "app.example.com", projectId: "proj_1" },
            ],
            [internal.projects.placement, placement],
        ]);
        const request = (): Request =>
            new Request("https://cloud.test/v1/domains/remove", { body: JSON.stringify({ id: "dom_1", organizationId: "org_1" }), method: "POST" });
        const deletes: string[] = [];

        vi.stubGlobal("fetch", (input: FetchInput, init?: RequestInit) => {
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

    it("releases the certificate through the issuer that issued it, after the project moved to a box", async () => {
        // The project is on celld-vps now; its domain still holds the certificate cloudflare-wfp issued.
        const moved = contextAnswering(
            new Map<unknown, unknown>([
                [
                    internal.domains.removalTarget,
                    { certificateIssuer: "cloudflare-wfp", certificateScope: ZONE, customHostnameId: "ch_1", hostname: "app.example.com", projectId: "proj_1" },
                ],
                [internal.projects.placement, { cellName: "default", host: { id: "box_1", slug: "bslug000001" }, target: "celld-vps" }],
            ]),
        );
        const calls: string[] = [];

        vi.stubGlobal("fetch", (input: FetchInput, init?: RequestInit) => {
            calls.push(`${init?.method ?? "GET"} ${input instanceof Request ? input.url : input.toString()}`);

            return Promise.resolve(Response.json({ result: { id: "ch_1" }, success: true }));
        });

        const response = await handleDomainRemoveRoute(
            new Request("https://cloud.test/v1/domains/remove", { body: JSON.stringify({ id: "dom_1", organizationId: "org_1" }), method: "POST" }),
            environment(moved.context),
        );

        expect(response.status).toBe(200);
        expect(calls).toStrictEqual([`DELETE https://api.cloudflare.com/client/v4/zones/${ZONE}/custom_hostnames/ch_1`]);
        expect(moved.mutations.map(({ reference }) => reference)).toStrictEqual([internal.domains.remove]);
    });

    it("keeps a domain whose certificate's issuer this control plane cannot reach", async () => {
        const kept = contextAnswering(
            new Map<unknown, unknown>([
                [
                    internal.domains.removalTarget,
                    {
                        certificateIssuer: "cloudflare-wfp",
                        certificateScope: "another-cells-zone",
                        customHostnameId: "ch_1",
                        hostname: "app.example.com",
                        projectId: "proj_1",
                    },
                ],
                [internal.projects.placement, placement],
            ]),
        );
        const calls = vi.fn<typeof fetch>();

        vi.stubGlobal("fetch", calls);

        const response = await handleDomainRemoveRoute(
            new Request("https://cloud.test/v1/domains/remove", { body: JSON.stringify({ id: "dom_1", organizationId: "org_1" }), method: "POST" }),
            environment(kept.context),
        );

        expect(response.status).toBe(502);
        expect(calls).not.toHaveBeenCalled();
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

/** A certificate recorded as issued by this cell's zone. */
const ISSUED_HERE = { certificateIssuer: "cloudflare-wfp", certificateScope: ZONE };

/** An `issuerOf` port holding exactly this cell's zone, whose issuer is `overrides`. */
const issuerIn =
    (overrides: Partial<CertificateIssuer>) =>
    (recorded: RecordedCertificate): CertificateIssuer | undefined =>
        recorded.certificateIssuer === "cloudflare-wfp" && recorded.certificateScope === ZONE
            ? { refresh: () => Promise.resolve(null), release: () => Promise.resolve(), scope: ZONE, ...overrides }
            : undefined;

describe(runCertificateSweep, () => {
    it("follows verified domains' certificates until they are active, and forgets one that vanished", async () => {
        const store = memoryStore({
            domains: [
                { _id: "dom_pending", ...ISSUED_HERE, customHostnameId: "ch_1", hostname: "a.example.com", updatedAt: 1, verifiedAt: 1 },
                {
                    _id: "dom_gone",
                    ...ISSUED_HERE,
                    certificateStatus: "pending_validation",
                    customHostnameId: "ch_2",
                    hostname: "b.example.com",
                    updatedAt: 2,
                    verifiedAt: 1,
                },
                {
                    _id: "dom_active",
                    ...ISSUED_HERE,
                    certificateStatus: "active",
                    customHostnameId: "ch_3",
                    hostname: "c.example.com",
                    updatedAt: 3,
                    verifiedAt: 1,
                },
                { _id: "dom_unverified", ...ISSUED_HERE, customHostnameId: "ch_4", hostname: "d.example.com", updatedAt: 4 },
                // Another cell's zone: its own control plane follows it.
                {
                    _id: "dom_elsewhere",
                    certificateIssuer: "cloudflare-wfp",
                    certificateScope: "other-zone",
                    customHostnameId: "ch_5",
                    hostname: "e.example.com",
                    updatedAt: 0,
                    verifiedAt: 1,
                },
            ],
        });
        const refreshed: string[] = [];
        const result = await runCertificateSweep({
            database: store,
            issuerOf: issuerIn({
                refresh: (id) => {
                    refreshed.push(id);

                    return Promise.resolve(id === "ch_1" ? { customHostnameId: "ch_1", sslStatus: "active" } : null);
                },
            }),
            now: 100,
        });

        expect(result).toStrictEqual({ checked: 2, failed: 0, issued: 1, released: 0, releaseFailed: 0 });
        expect(refreshed).toStrictEqual(["ch_1", "ch_2"]);
        expect(store.tables["domains"]?.find((row) => row["_id"] === "dom_pending")).toMatchObject({ certificateError: null, certificateStatus: "active" });
        expect(store.tables["domains"]?.find((row) => row["_id"] === "dom_gone")).toMatchObject({
            certificateIssuer: null,
            certificateStatus: "missing",
            customHostnameId: null,
        });
    });

    it("reads a bounded batch a tick, and survives a failed read", async () => {
        const store = memoryStore({
            domains: Array.from({ length: MAX_CERTIFICATES_PER_TICK + 10 }, (_, index) => {
                return {
                    _id: `dom_${String(index)}`,
                    ...ISSUED_HERE,
                    customHostnameId: `ch_${String(index)}`,
                    hostname: "x.example.com",
                    updatedAt: index,
                    verifiedAt: 1,
                };
            }),
        });
        const result = await runCertificateSweep({
            database: store,
            issuerOf: issuerIn({ refresh: () => Promise.reject(new Error("rate limited")) }),
            log: () => undefined,
            now: 100,
        });

        expect(result).toStrictEqual({ checked: MAX_CERTIFICATES_PER_TICK, failed: MAX_CERTIFICATES_PER_TICK, issued: 0, released: 0, releaseFailed: 0 });
    });

    it("releases the queued certificates of deleted domains through their issuer, then forgets them", async () => {
        const store = memoryStore({
            certificateReleases: [
                { _id: "rel_1", ...ISSUED_HERE, customHostnameId: "ch_1", hostname: "a.example.com", queuedAt: 1 },
                { _id: "rel_2", ...ISSUED_HERE, customHostnameId: "ch_2", hostname: "b.example.com", queuedAt: 2 },
                // Another cell's zone: its own control plane releases it.
                {
                    _id: "rel_3",
                    certificateIssuer: "cloudflare-wfp",
                    certificateScope: "other-zone",
                    customHostnameId: "ch_3",
                    hostname: "c.example.com",
                    queuedAt: 0,
                },
            ],
            domains: [],
        });
        const released: string[] = [];
        const result = await runCertificateSweep({
            database: store,
            issuerOf: issuerIn({
                release: (id) => {
                    if (id === "ch_2") {
                        return Promise.reject(new Error("upstream down"));
                    }

                    released.push(id);

                    return Promise.resolve();
                },
            }),
            log: () => undefined,
            now: 100,
        });

        expect(result).toMatchObject({ released: 1, releaseFailed: 1 });
        expect(released).toStrictEqual(["ch_1"]);
        // Released → forgotten; failed → kept with its error for the next tick; another zone's → untouched.
        expect(store.tables["certificateReleases"]?.map((row) => row["_id"])).toStrictEqual(["rel_2", "rel_3"]);
        expect(store.tables["certificateReleases"]?.[0]).toMatchObject({ attempts: 1, lastError: "upstream down" });
    });
});

describe("deleting what a certificate belongs to", () => {
    const certified = { certificateIssuer: "cloudflare-wfp", certificateScope: ZONE, customHostnameId: "ch_1", hostname: "app.example.com" };
    const releasesQueued = (ops: ReturnType<typeof makeCtx>["ops"]) =>
        ops.flatMap((op) => (op.kind === "insert" && op.table === "certificateReleases" ? [op.document] : []));

    it("queues a deleted project's certificates for release before its domain rows go", async () => {
        const { ctx, ops } = makeCtx({
            aliasOwnership: [],
            buildLogs: [],
            builds: [],
            deployments: [],
            domains: [
                { _id: "dom_1", organizationId: "org_1", projectId: "proj_1", ...certified },
                // Never verified: no certificate to release.
                { _id: "dom_2", hostname: "plain.example.com", organizationId: "org_1", projectId: "proj_1" },
            ],
            members: [owner("org_1")],
            projects: [{ _id: "proj_1", organizationId: "org_1" }],
            secrets: [],
        });

        await removeProject.handler(ctx, { id: "proj_1" as never, organizationId: "org_1" as never });

        expect(releasesQueued(ops)).toStrictEqual([
            { certificateIssuer: "cloudflare-wfp", certificateScope: ZONE, customHostnameId: "ch_1", hostname: "app.example.com", queuedAt: ctx.now },
        ]);

        const queuedAt = ops.findIndex((op) => op.kind === "insert" && op.table === "certificateReleases");
        const domainDeletedAt = ops.findIndex((op) => op.kind === "delete" && op.id === "dom_1");

        expect(queuedAt).toBeLessThan(domainDeletedAt);
    });

    it("queues a purged organization's certificates for release", async () => {
        const now = 400 * 24 * 60 * 60 * 1000;
        const tables: Record<string, Record<string, unknown>[]> = Object.fromEntries(PURGED_TABLES.map((table) => [table, []]));
        const { ctx, ops } = makeCtx(
            {
                ...tables,
                deployments: [],
                domains: [{ _id: "dom_1", organizationId: "org_1", projectId: "proj_1", ...certified }],
                organizations: [{ _id: "org_1", deletionRequestedAt: 1 }],
            },
            { now },
        );

        await expect(purgeDeleted.handler(ctx, {})).resolves.toStrictEqual({ purged: 1 });
        expect(releasesQueued(ops)).toStrictEqual([
            { certificateIssuer: "cloudflare-wfp", certificateScope: ZONE, customHostnameId: "ch_1", hostname: "app.example.com", queuedAt: now },
        ]);
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
