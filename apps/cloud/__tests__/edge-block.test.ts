import { describe, expect, it } from "vitest";

import type { CloudflareApi, CustomHostname } from "../src/cloudflare/api";
import type { HostList, HostListItem } from "../src/cloudflare/host-list";
import { createHttpHostList, MAX_LIST_PAGES } from "../src/cloudflare/host-list";
import { edgeBlockModeOf } from "../src/domains/edge-block-mode";
import { reconcileEdgeBlocks } from "../src/targets/cloudflare-wfp/edge-block";
import { memoryStore } from "./support/memory-store";

/**
 * Edge-block suspension (plan 365 W8). The properties that matter: a failed
 * block never touches the suspension, a failed restore stays marked and is
 * retried, every step is idempotent across ticks, and a tenant off the
 * platform's zone (a box) is never touched.
 */

const ZONE = "zone_saas";

/** A SaaS zone in memory, with per-method failure injection. */
const memoryZone = (seed: CustomHostname[] = []) => {
    const hostnames = new Map(seed.map((hostname) => [hostname.id, hostname]));
    const fail: { create?: Error; delete?: Error } = {};
    let next = 0;
    const unused = (): Promise<never> => Promise.reject(new Error("not used by this test"));
    const api: CloudflareApi = {
        createCustomHostname: ({ hostname }) => {
            if (fail.create) {
                return Promise.reject(fail.create);
            }

            next += 1;

            const created: CustomHostname = { errors: [], hostname, id: `ch_new_${String(next)}`, sslStatus: "initializing", status: "pending" };

            hostnames.set(created.id, created);

            return Promise.resolve(created);
        },
        createDnsRecord: unused,
        deleteCustomHostname: ({ id }) => (fail.delete ? Promise.reject(fail.delete) : Promise.resolve(hostnames.delete(id))),
        deleteDnsRecord: unused,
        exportD1Database: unused,
        findCustomHostname: ({ hostname }) => Promise.resolve([...hostnames.values()].find((candidate) => candidate.hostname === hostname) ?? null),
        getCustomHostname: ({ id }) => Promise.resolve(hostnames.get(id) ?? null),
        listDnsRecords: unused,
        listDnsRecordsUnder: unused,
    };

    return { fail, hostnames, zone: { api, zoneId: ZONE } };
};

/** An account hostname list in memory. Cloudflare applies bulk ops asynchronously; this applies them at once. */
const memoryList = (seed: string[] = []) => {
    let next = 0;
    const items: HostListItem[] = seed.map((hostname) => {
        next += 1;

        return { hostname, id: `item_${String(next)}` };
    });
    const fail: { add?: Error } = {};
    const ops: string[] = [];
    const list: HostList = {
        add: (hostnames) => {
            if (fail.add) {
                return Promise.reject(fail.add);
            }

            ops.push(`add ${hostnames.join(",")}`);

            for (const hostname of hostnames) {
                next += 1;
                items.push({ hostname, id: `item_${String(next)}` });
            }

            return Promise.resolve();
        },
        items: () => Promise.resolve({ items: [...items], truncated: false }),
        remove: (ids) => {
            ops.push(`remove ${ids.join(",")}`);

            for (const id of ids) {
                items.splice(
                    items.findIndex((item) => item.id === id),
                    1,
                );
            }

            return Promise.resolve();
        },
    };

    return { fail, hostnames: () => items.map((item) => item.hostname).toSorted((a, b) => a.localeCompare(b)), list, ops };
};

const NOW = 1_800_000_000_000;

const customHostname = (id: string, hostname: string): CustomHostname => {
    return { errors: [], hostname, id, sslStatus: "active", status: "active" };
};

const domain = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    return {
        _id: "dom_1",
        certificateIssuer: "cloudflare-wfp",
        certificateScope: ZONE,
        certificateStatus: "active",
        customHostnameId: "ch_1",
        hostname: "app.example.com",
        organizationId: "org_1",
        verifiedAt: 1,
        ...over,
    };
};

const audits = (store: ReturnType<typeof memoryStore>): unknown[] =>
    (store.tables["auditLog"] ?? []).map((row) => {
        return { action: row["action"], organizationId: row["organizationId"] };
    });

/** Deletion is opted in for the suites that exercise it; the default-off behaviour has its own suite below. */
const run = async (
    store: ReturnType<typeof memoryStore>,
    ports: { deleteHostnames?: boolean; hostList?: HostList; zone?: ReturnType<typeof memoryZone>["zone"] },
) => reconcileEdgeBlocks(store, { appDomain: "lunora.app", deleteHostnames: true, log: () => undefined, now: NOW, ...ports });

describe("edge block — modes", () => {
    it.each([
        [{}, "dispatcher"],
        [{ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", LUNORA_SAAS_ZONE_ID: ZONE }, "dispatcher"],
        [{ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES: "true", LUNORA_SAAS_ZONE_ID: ZONE }, "dispatcher"],
        [{ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES: "1", LUNORA_SAAS_ZONE_ID: ZONE }, "delete-hostnames"],
        [{ CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t", LUNORA_EDGE_BLOCK_DELETE_HOSTNAMES: "1", LUNORA_SUSPENDED_HOSTS_LIST_ID: "l" }, "list"],
        [{ LUNORA_SUSPENDED_HOSTS_LIST_ID: "l" }, "dispatcher"],
    ])("reads %o as %s", (environment, mode) => {
        expect(edgeBlockModeOf(environment)).toBe(mode);
    });

    /** Deletion is destructive to the customer's domains, so without the opt-in it never happens. */
    it("deletes nothing without the opt-in, and still restores what an earlier opt-in blocked", async () => {
        const { hostnames, zone } = memoryZone([customHostname("ch_1", "app.example.com")]);
        const store = memoryStore({
            domains: [domain(), domain({ _id: "dom_2", customHostnameId: null, edgeBlockedAt: 9, hostname: "two.example.com", organizationId: "org_2" })],
            organizations: [{ _id: "org_1", suspendedAt: 5 }, { _id: "org_2" }],
        });

        await expect(run(store, { deleteHostnames: false, zone })).resolves.toStrictEqual({ blocked: 0, failed: 0, unblocked: 1 });
        expect(hostnames.has("ch_1")).toBe(true);
        expect(store.tables["domains"]?.[0]).toMatchObject({ customHostnameId: "ch_1", certificateStatus: "active" });
    });
});

describe("edge block — custom hostname removal (opted in, no list)", () => {
    it("removes a suspended org's custom hostname, marks the domain, audits it, and leaves the suspension alone", async () => {
        const { hostnames, zone } = memoryZone([customHostname("ch_1", "app.example.com")]);
        const store = memoryStore({ domains: [domain()], organizations: [{ _id: "org_1", suspendedAt: 5, suspendedReason: "spend-cap" }] });

        await expect(run(store, { zone })).resolves.toStrictEqual({ blocked: 1, failed: 0, unblocked: 0 });

        expect(hostnames.size).toBe(0);
        expect(store.tables["domains"]?.[0]).toMatchObject({
            certificateScope: ZONE,
            certificateStatus: "suspended",
            customHostnameId: null,
            edgeBlockedAt: NOW,
        });
        expect(store.tables["organizations"]?.[0]).toMatchObject({ suspendedAt: 5, suspendedReason: "spend-cap" });
        expect(audits(store)).toStrictEqual([{ action: "domain.edge_block", organizationId: "org_1" }]);
    });

    it("is idempotent: a second tick does nothing, and a delete of an already-gone hostname still completes", async () => {
        const { zone } = memoryZone();
        const store = memoryStore({ domains: [domain({ customHostnameId: "ch_gone" })], organizations: [{ _id: "org_1", suspendedAt: 5 }] });

        await expect(run(store, { zone })).resolves.toMatchObject({ blocked: 1 });
        await expect(run(store, { zone })).resolves.toStrictEqual({ blocked: 0, failed: 0, unblocked: 0 });
    });

    /** A failed block must never un-suspend, nor mark the domain blocked when it is not. */
    it("records a failed block on the row, audits it once, and retries it", async () => {
        const { fail, hostnames, zone } = memoryZone([customHostname("ch_1", "app.example.com")]);
        const store = memoryStore({ domains: [domain()], organizations: [{ _id: "org_1", suspendedAt: 5 }] });

        fail.delete = new Error("Cloudflare DELETE /zones/zone_saas/custom_hostnames/ch_1 failed: HTTP 500");

        await expect(run(store, { zone })).resolves.toStrictEqual({ blocked: 0, failed: 1, unblocked: 0 });

        await run(store, { zone });

        expect(store.tables["domains"]?.[0]).toMatchObject({ customHostnameId: "ch_1", edgeBlockError: expect.stringContaining("HTTP 500") });
        expect(store.tables["domains"]?.[0]?.["edgeBlockedAt"]).toBeUndefined();
        expect(store.tables["organizations"]?.[0]).toMatchObject({ suspendedAt: 5 });
        expect(audits(store)).toStrictEqual([{ action: "domain.edge_block_failed", organizationId: "org_1" }]);

        fail.delete = undefined;

        await expect(run(store, { zone })).resolves.toMatchObject({ blocked: 1 });
        expect(hostnames.size).toBe(0);
        expect(store.tables["domains"]?.[0]).toMatchObject({ edgeBlockError: null });
    });

    it("restores a recovered org's custom hostname and clears the marker", async () => {
        const { hostnames, zone } = memoryZone();
        const store = memoryStore({
            domains: [domain({ certificateStatus: "suspended", customHostnameId: null, edgeBlockedAt: 9 })],
            organizations: [{ _id: "org_1", suspendedAt: null }],
        });

        await expect(run(store, { zone })).resolves.toStrictEqual({ blocked: 0, failed: 0, unblocked: 1 });

        expect(hostnames.size).toBe(1);
        expect(store.tables["domains"]?.[0]).toMatchObject({ certificateStatus: "initializing", customHostnameId: "ch_new_1", edgeBlockedAt: null });
        expect(audits(store)).toStrictEqual([{ action: "domain.edge_unblock", organizationId: "org_1" }]);
    });

    it("keeps a failed restore marked and visible, then adopts the hostname a half-finished restore created", async () => {
        const { fail, hostnames, zone } = memoryZone();
        const store = memoryStore({
            domains: [domain({ certificateStatus: "suspended", customHostnameId: null, edgeBlockedAt: 9 })],
            organizations: [{ _id: "org_1" }],
        });

        fail.create = new Error("Cloudflare POST /zones/zone_saas/custom_hostnames failed: rate limited");

        await expect(run(store, { zone })).resolves.toMatchObject({ failed: 1 });
        expect(store.tables["domains"]?.[0]).toMatchObject({ edgeBlockedAt: 9, edgeBlockError: expect.stringContaining("rate limited") });

        // The create reached Cloudflare but the row write did not: the next tick adopts it, never a second one.
        fail.create = undefined;
        hostnames.set("ch_orphan", customHostname("ch_orphan", "app.example.com"));

        await expect(run(store, { zone })).resolves.toMatchObject({ unblocked: 1 });
        expect(hostnames.size).toBe(1);
        expect(store.tables["domains"]?.[0]).toMatchObject({ customHostnameId: "ch_orphan", edgeBlockedAt: null, edgeBlockError: null });
    });

    it("refuses to adopt a hostname queued for release, which would be pulled from under the domain", async () => {
        const { zone } = memoryZone([customHostname("ch_queued", "app.example.com")]);
        const store = memoryStore({
            certificateReleases: [{ _id: "rel_1", customHostnameId: "ch_queued" }],
            domains: [domain({ customHostnameId: null, edgeBlockedAt: 9 })],
            organizations: [{ _id: "org_1" }],
        });

        await expect(run(store, { zone })).resolves.toMatchObject({ failed: 1, unblocked: 0 });
        expect(store.tables["domains"]?.[0]).toMatchObject({ edgeBlockedAt: 9 });
    });

    it("never touches a certificate another zone holds, or a box domain with none", async () => {
        const { zone } = memoryZone([customHostname("ch_1", "app.example.com")]);
        const store = memoryStore({
            domains: [
                domain({ _id: "other_zone", certificateScope: "zone_other" }),
                domain({ _id: "box", certificateIssuer: null, certificateScope: null, customHostnameId: null, hostname: "box.example.com" }),
            ],
            organizations: [{ _id: "org_1", suspendedAt: 5 }],
        });

        await expect(run(store, { zone })).resolves.toStrictEqual({ blocked: 0, failed: 0, unblocked: 0 });
    });
});

/**
 * The mapping a tick planned from (domain → org → Cloudflare id) is re-confirmed
 * against the current rows and Cloudflare at the moment of each write. These
 * change the world between the tick's read and its write.
 */
describe("edge block — stale mappings fail closed", () => {
    /** Run `change` on the store the first time the sweep re-reads `dom_1` — after it planned, before it writes. */
    const changingOnReread = (store: ReturnType<typeof memoryStore>, change: () => void): ReturnType<typeof memoryStore> => {
        let changed = false;

        return {
            ...store,
            get: async (id, table) => {
                if (id === "dom_1" && !changed) {
                    changed = true;
                    change();
                }

                return store.get(id, table);
            },
        };
    };

    it("does not delete when Cloudflare maps the recorded id to another hostname", async () => {
        const { hostnames, zone } = memoryZone([customHostname("ch_1", "someone-else.example.com")]);
        const store = memoryStore({ domains: [domain()], organizations: [{ _id: "org_1", suspendedAt: 5 }] });

        await expect(run(store, { zone })).resolves.toStrictEqual({ blocked: 0, failed: 1, unblocked: 0 });
        expect(hostnames.has("ch_1")).toBe(true);
        expect(store.tables["domains"]?.[0]).toMatchObject({ customHostnameId: "ch_1", edgeBlockError: expect.stringContaining("refusing to delete") });
    });

    it("does not block a domain reassigned to a serving org between plan and write", async () => {
        const { hostnames, zone } = memoryZone([customHostname("ch_1", "app.example.com")]);
        const base = memoryStore({
            domains: [domain()],
            organizations: [
                { _id: "org_1", suspendedAt: 5 },
                { _id: "org_2", suspendedAt: null },
            ],
        });
        const store = changingOnReread(base, () => {
            const rows = base.tables["domains"] ?? [];

            rows[0] = { ...rows[0], organizationId: "org_2" };
        });

        await expect(run(store, { zone })).resolves.toMatchObject({ blocked: 0, failed: 1 });
        expect(hostnames.has("ch_1")).toBe(true);
        expect(base.tables["auditLog"]?.some((row) => row["organizationId"] === "org_2")).toBe(false);
    });

    it("does not block when the recorded custom hostname id changed under the row", async () => {
        const { hostnames, zone } = memoryZone([customHostname("ch_1", "app.example.com"), customHostname("ch_2", "app.example.com")]);
        const base = memoryStore({ domains: [domain()], organizations: [{ _id: "org_1", suspendedAt: 5 }] });
        const store = changingOnReread(base, () => {
            const rows = base.tables["domains"] ?? [];

            rows[0] = { ...rows[0], customHostnameId: "ch_2" };
        });

        await expect(run(store, { zone })).resolves.toMatchObject({ blocked: 0, failed: 1 });
        expect(hostnames.size).toBe(2);
    });

    it("does not restore a hostname that was removed and re-added by another org between plan and write", async () => {
        const { hostnames, zone } = memoryZone();
        const base = memoryStore({
            domains: [domain({ customHostnameId: null, edgeBlockedAt: 9 })],
            organizations: [{ _id: "org_1" }, { _id: "org_2", suspendedAt: 5 }],
        });
        const store = changingOnReread(base, () => {
            base.tables["domains"] = [domain({ _id: "dom_2", customHostnameId: null, organizationId: "org_2" })];
        });

        await expect(run(store, { zone })).resolves.toMatchObject({ failed: 1, unblocked: 0 });
        expect(hostnames.size).toBe(0);
    });

    it("does not adopt a custom hostname another domain row records", async () => {
        const { hostnames, zone } = memoryZone([customHostname("ch_theirs", "app.example.com")]);
        const store = memoryStore({
            domains: [
                domain({ customHostnameId: null, edgeBlockedAt: 9 }),
                domain({ _id: "dom_other", customHostnameId: "ch_theirs", hostname: "other.example.com", organizationId: "org_2" }),
            ],
            organizations: [{ _id: "org_1" }, { _id: "org_2" }],
        });

        await expect(run(store, { zone })).resolves.toMatchObject({ failed: 1, unblocked: 0 });
        expect(hostnames.size).toBe(1);
        expect(store.tables["domains"]?.[0]).toMatchObject({ edgeBlockedAt: 9, edgeBlockError: expect.stringContaining("not adopting") });
    });

    it("leaves a hostname two organizations' rows name off the list", async () => {
        const { hostnames, list } = memoryList();
        const store = memoryStore({
            deployments: [
                { _id: "d1", alias: "acme", organizationId: "org_1", scriptName: "acme", status: "live" },
                { _id: "d2", alias: "acme", organizationId: "org_2", scriptName: "acme", status: "live" },
                { _id: "d3", alias: "solo", organizationId: "org_1", scriptName: "solo", status: "live" },
            ],
            domains: [],
            organizations: [
                { _id: "org_1", suspendedAt: 5 },
                { _id: "org_2", suspendedAt: null },
            ],
        });

        await run(store, { hostList: list });

        expect(hostnames()).toStrictEqual(["solo.lunora.app"]);
    });
});

describe("edge block — suspended-hostnames list", () => {
    const seed = (suspendedAt: null | number) =>
        memoryStore({
            deployments: [
                { _id: "d1", alias: "acme", organizationId: "org_1", scriptName: "acme", status: "live" },
                { _id: "d2", alias: "old", organizationId: "org_1", scriptName: "old", status: "destroyed" },
                { _id: "d3", alias: "boxed", organizationId: "org_1", scriptName: "boxed", status: "live", target: "celld-vps" },
                { _id: "d4", alias: "other", organizationId: "org_2", scriptName: "other", status: "live" },
            ],
            domains: [domain()],
            organizations: [
                { _id: "org_1", suspendedAt },
                { _id: "org_2", suspendedAt: null },
            ],
        });

    it("lists a suspended org's live platform hostnames and custom domains, keeps its certificates, and audits it", async () => {
        const { hostnames, list } = memoryList();
        const { hostnames: zoneHostnames, zone } = memoryZone([customHostname("ch_1", "app.example.com")]);
        const store = seed(5);

        await expect(run(store, { hostList: list, zone })).resolves.toStrictEqual({ blocked: 2, failed: 0, unblocked: 0 });

        // No destroyed release, no box tenant, no other org.
        expect(hostnames()).toStrictEqual(["acme.lunora.app", "app.example.com"]);
        expect(zoneHostnames.size).toBe(1);
        expect(audits(store)).toStrictEqual([{ action: "organization.edge_block", organizationId: "org_1" }]);
    });

    it("removes the org's hostnames once it recovers, and any item it no longer wants", async () => {
        const { hostnames, list } = memoryList(["acme.lunora.app", "app.example.com", "stale.example.com"]);
        const store = seed(null);

        await expect(run(store, { hostList: list })).resolves.toStrictEqual({ blocked: 0, failed: 0, unblocked: 3 });
        expect(hostnames()).toStrictEqual([]);
        expect(audits(store)).toStrictEqual([{ action: "organization.edge_unblock", organizationId: "org_1" }]);
    });

    it("does one bulk operation per tick, adds first, and converges", async () => {
        const { list, ops } = memoryList(["stale.example.com"]);
        const store = seed(5);

        await run(store, { hostList: list });
        await run(store, { hostList: list });
        await run(store, { hostList: list });

        expect(ops).toStrictEqual(["add acme.lunora.app,app.example.com", "remove item_1"]);
    });

    it("reports a failed list write and leaves the domain rows untouched", async () => {
        const { fail, list } = memoryList();
        const store = seed(5);

        fail.add = new Error("Cloudflare POST /accounts/a/rules/lists/l/items failed: a bulk operation is already pending");

        await expect(run(store, { hostList: list })).resolves.toStrictEqual({ blocked: 0, failed: 1, unblocked: 0 });
        expect(store.tables["domains"]?.[0]).toMatchObject({ customHostnameId: "ch_1" });
        expect(store.tables["organizations"]?.[0]).toMatchObject({ suspendedAt: 5 });
    });
});

describe(createHttpHostList, () => {
    const answer = (result: unknown[], after?: string): Response =>
        Response.json({ result, result_info: after === undefined ? {} : { cursors: { after } }, success: true });

    it("pages by cursor, and drops items that are not well-formed hostname items", async () => {
        const urls: string[] = [];
        const list = createHttpHostList({
            accountId: "acc",
            apiToken: "token",
            baseUrl: "https://api.test/client/v4",
            fetch: (input) => {
                const url = input instanceof Request ? input.url : input.toString();

                urls.push(url);

                return Promise.resolve(
                    url.includes("cursor=")
                        ? answer([{ hostname: { url_hostname: "B.example.com" }, id: "i2" }])
                        : answer(
                              [
                                  { hostname: { url_hostname: "a.example.com" }, id: "i1" },
                                  { id: "no-hostname" },
                                  { hostname: { url_hostname: "x".repeat(300) }, id: "i3" },
                              ],
                              "c1",
                          ),
                );
            },
            listId: "list_1",
        });

        await expect(list.items()).resolves.toStrictEqual({
            items: [
                { hostname: "a.example.com", id: "i1" },
                { hostname: "b.example.com", id: "i2" },
            ],
            truncated: false,
        });
        expect(urls).toStrictEqual([
            "https://api.test/client/v4/accounts/acc/rules/lists/list_1/items?per_page=500",
            "https://api.test/client/v4/accounts/acc/rules/lists/list_1/items?per_page=500&cursor=c1",
        ]);
    });

    it("stops at the page bound and says so", async () => {
        let calls = 0;
        const list = createHttpHostList({
            accountId: "acc",
            apiToken: "token",
            fetch: () => {
                calls += 1;

                return Promise.resolve(answer([], `c${String(calls)}`));
            },
            listId: "list_1",
        });

        await expect(list.items()).resolves.toMatchObject({ truncated: true });
        expect(calls).toBe(MAX_LIST_PAGES);
    });

    it("sends the documented add and delete bodies", async () => {
        const bodies: unknown[] = [];
        const list = createHttpHostList({
            accountId: "acc",
            apiToken: "token",
            fetch: (_input, init) => {
                bodies.push({ body: JSON.parse(init?.body as string), method: init?.method });

                return Promise.resolve(Response.json({ result: { operation_id: "op" }, success: true }));
            },
            listId: "list_1",
        });

        await list.add(["a.example.com"]);
        await list.remove(["i1"]);

        expect(bodies).toStrictEqual([
            { body: [{ comment: "lunora: organization suspended", hostname: { url_hostname: "a.example.com" } }], method: "POST" },
            { body: { items: [{ id: "i1" }] }, method: "DELETE" },
        ]);
    });
});
