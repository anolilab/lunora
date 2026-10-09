/* eslint-disable no-secrets/no-secrets -- GraphQL dataset and operation names read as entropy; none is a credential */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PeriodUsage } from "../src/billing/spend";
import { CloudflareTokenError } from "../src/cloudflare/fetch";
import {
    D1_QUERY_BATCH,
    probeDurableObjectsDataset,
    readD1UsageByAlias,
    readDurableObjectUsageByScript,
    resetDurableObjectsProbe,
    STORAGE_QUERY_LIMIT,
} from "../src/cloudflare/storage-usage";
import { meteringNotices, parseScopeKey } from "../src/metering/status";
import { UsageUnavailableError } from "../src/metering/unavailable";
import { cloudflareWfpFleetFromEnv, createCloudflareWfpFleet } from "../src/targets/cloudflare-wfp/driver";
import { cloudflareWorkersFleetFromEnv, createCloudflareWorkersFleet } from "../src/targets/cloudflare-workers/driver";
import type { UsageWindow } from "../src/targets/driver";
import { resourceRefOf } from "../src/targets/placement";

const ACCOUNT = "a".repeat(32);
const TOKEN = "cf-token-that-must-never-leak-0123456789";
const HOUR = 60 * 60 * 1000;
/** A closed, hour-aligned window: 09:00–11:00 on 15 June. */
const WINDOW = { sinceMs: Date.UTC(2026, 5, 15, 9), untilMs: Date.UTC(2026, 5, 15, 11) };

interface GraphqlRequest {
    query: string;
    variables: Record<string, unknown>;
}

/** A fake Cloudflare API: REST listings by path, and every GraphQL request handed to `graphql`. */
const fakeCloudflare = (options: {
    graphql: (request: GraphqlRequest) => { data?: unknown; errors?: { message: string }[]; status?: number };
    rest?: Record<string, (page: number) => { result: unknown[]; totalPages?: number } | { status: number }>;
}) =>
    vi.fn<typeof fetch>(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const path = url.pathname.replace("/client/v4", "");

        if (path === "/graphql") {
            const answer = options.graphql(JSON.parse(init?.body as string) as GraphqlRequest);

            return Response.json({ data: answer.data ?? null, errors: answer.errors ?? null }, { status: answer.status ?? 200 });
        }

        const listing = options.rest?.[path];

        if (listing === undefined) {
            return Response.json({ errors: [{ message: "not found" }], success: false }, { status: 404 });
        }

        const answer = listing(Number(url.searchParams.get("page") ?? "1"));

        return "status" in answer
            ? Response.json({ errors: [{ message: "Authentication error" }], success: false }, { status: answer.status })
            : Response.json({ result: answer.result, result_info: { total_pages: answer.totalPages ?? 1 }, success: true });
    });

const access = (fetch: typeof globalThis.fetch) => {
    return { accountId: ACCOUNT, apiToken: TOKEN, fetch };
};

describe(readD1UsageByAlias, () => {
    it("reads every tenant database's closed hours, attributed to its alias by name, across listing pages", async () => {
        const queries: string[] = [];
        const fetch = fakeCloudflare({
            graphql: ({ query }) => {
                queries.push(query);

                // One aliased field per database, keyed by its uuid.
                const rows: Record<string, unknown> = {};

                for (const [, index, uuid] of query.matchAll(/d(\d+): d1AnalyticsAdaptiveGroups\(limit: \d+, filter: \{ databaseId: "([^"]+)"/gu)) {
                    rows[`d${index}`] = {
                        "uuid-shop-db": [
                            { dimensions: { datetimeHour: "2026-06-15T09:00:00Z" }, sum: { rowsRead: 1000, rowsWritten: 10 } },
                            { dimensions: { datetimeHour: "2026-06-15T10:00:00Z" }, sum: { rowsRead: 500, rowsWritten: 5 } },
                        ],
                        "uuid-shop-cache": [{ dimensions: { datetimeHour: "2026-06-15T09:00:00Z" }, sum: { rowsRead: 7, rowsWritten: 0 } }],
                        "uuid-blog-db": [{ dimensions: { datetimeHour: "2026-06-15T10:00:00Z" }, sum: { rowsRead: 3, rowsWritten: 1 } }],
                    }[uuid ?? ""];
                }

                return { data: { viewer: { accounts: [rows] } } };
            },
            rest: {
                [`/accounts/${ACCOUNT}/d1/database`]: (page) =>
                    page === 1
                        ? {
                              result: [
                                  { name: "shop--db", uuid: "uuid-shop-db" },
                                  { name: "shop--cache", uuid: "uuid-shop-cache" },
                                  // The platform's own database: no tenant produced its name.
                                  { name: "lunora-cloud", uuid: "uuid-platform" },
                              ],
                              totalPages: 2,
                          }
                        : { result: [{ name: "blog--db", uuid: "uuid-blog-db" }], totalPages: 2 },
            },
        });

        const usage = await readD1UsageByAlias(access(fetch), WINDOW);

        expect(Object.fromEntries(usage)).toStrictEqual({
            blog: { d1RowsRead: 3, d1RowsWritten: 1 },
            shop: { d1RowsRead: 1507, d1RowsWritten: 15 },
        });
        expect(queries).toHaveLength(1);
        // `datetimeHour_leq` is inclusive, so it names the window's last hour, never the open one.
        expect(queries[0]).toContain('datetimeHour_geq: "2026-06-15T09:00:00.000Z", datetimeHour_leq: "2026-06-15T10:00:00.000Z"');
        expect(queries[0]).not.toContain("uuid-platform");
    });

    it("batches the databases into requests of a bounded size", async () => {
        const databases = Array.from({ length: D1_QUERY_BATCH + 1 }, (_, index) => {
            return { name: `app${String(index)}--db`, uuid: `uuid-${String(index)}` };
        });
        const graphql = vi.fn<(request: GraphqlRequest) => { data: unknown }>(() => {
            return { data: { viewer: { accounts: [{}] } } };
        });
        const fetch = fakeCloudflare({
            graphql,
            rest: {
                [`/accounts/${ACCOUNT}/d1/database`]: () => {
                    return { result: databases };
                },
            },
        });

        await readD1UsageByAlias(access(fetch), WINDOW);

        expect(graphql).toHaveBeenCalledTimes(2);
    });

    it("refuses a result at the row limit rather than record a truncated count", async () => {
        const fetch = fakeCloudflare({
            graphql: () => {
                return {
                    data: {
                        viewer: {
                            accounts: [
                                {
                                    d0: Array.from({ length: STORAGE_QUERY_LIMIT }, () => {
                                        return { sum: { rowsRead: 1, rowsWritten: 0 } };
                                    }),
                                },
                            ],
                        },
                    },
                };
            },
            rest: {
                [`/accounts/${ACCOUNT}/d1/database`]: () => {
                    return { result: [{ name: "shop--db", uuid: "uuid-shop-db" }] };
                },
            },
        });

        await expect(readD1UsageByAlias(access(fetch), WINDOW)).rejects.toThrow(/row limit/u);
    });

    it("reports a token without Account Analytics Read as a refused token", async () => {
        const fetch = fakeCloudflare({
            graphql: () => {
                return { errors: [{ message: "not authorized for that account" }] };
            },
            rest: {
                [`/accounts/${ACCOUNT}/d1/database`]: () => {
                    return { result: [{ name: "shop--db", uuid: "uuid-shop-db" }] };
                },
            },
        });

        const failure = await readD1UsageByAlias(access(fetch), WINDOW).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(CloudflareTokenError);
        expect(String(failure)).not.toContain(TOKEN);
    });
});

/** One `durableObjects*` dataset of the fake schema. */
interface DatasetShape {
    dimensions: string[];
    filter: string[];
    sum: string[];
}

const named = (name: string) => {
    return { kind: "OBJECT", name, ofType: null };
};

/**
 * A GraphQL schema as introspection describes it: `Query.viewer: Viewer!`,
 * `Viewer.accounts: [Account]`, and on `Account` one field per dataset.
 */
const schemaTypes = (datasets: Record<string, DatasetShape>): Record<string, unknown> => {
    const types: Record<string, unknown> = {
        Account: {
            fields: [
                {
                    args: [{ name: "filter", type: named("D1Filter") }],
                    name: "d1AnalyticsAdaptiveGroups",
                    type: { kind: "LIST", name: null, ofType: named("D1Group") },
                },
                ...Object.keys(datasets).map((name) => {
                    return {
                        args: [
                            { name: "limit", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "uint64", ofType: null } } },
                            { name: "filter", type: named(`${name}Filter`) },
                        ],
                        name,
                        type: { kind: "LIST", name: null, ofType: { kind: "NON_NULL", name: null, ofType: named(`${name}Group`) } },
                    };
                }),
            ],
        },
        Viewer: { fields: [{ name: "accounts", type: { kind: "LIST", name: null, ofType: named("Account") } }] },
    };

    for (const [name, shape] of Object.entries(datasets)) {
        types[`${name}Group`] = {
            fields: [
                { name: "sum", type: named(`${name}Sum`) },
                { name: "dimensions", type: named(`${name}Dimensions`) },
            ],
        };
        types[`${name}Sum`] = {
            fields: shape.sum.map((field) => {
                return { name: field };
            }),
            inputFields: null,
        };
        types[`${name}Dimensions`] = {
            fields: shape.dimensions.map((field) => {
                return { name: field };
            }),
            inputFields: null,
        };
        types[`${name}Filter`] = {
            fields: null,
            inputFields: shape.filter.map((field) => {
                return { name: field };
            }),
        };
    }

    return types;
};

/** A fake GraphQL API: introspection over `datasets`, and `rows` for the data query. */
const fakeGraphql =
    (datasets: Record<string, DatasetShape>, rows: unknown[] = [], seen: string[] = []) =>
    ({ query }: GraphqlRequest) => {
        seen.push(query);

        if (query.includes("__schema")) {
            return { data: { __schema: { queryType: { fields: [{ name: "viewer", type: { kind: "NON_NULL", name: null, ofType: named("Viewer") } }] } } } };
        }

        if (query.includes("__type")) {
            const types = schemaTypes(datasets);

            return {
                data: Object.fromEntries([...query.matchAll(/(t\d+): __type\(name: "(\w+)"\)/gu)].map(([, alias, name]) => [alias, types[name ?? ""] ?? null])),
            };
        }

        return { data: { viewer: { accounts: [{ rows }] } } };
    };

const HOURLY_FILTER = ["datetimeHour_geq", "datetimeHour_leq", "scriptName"];

describe(probeDurableObjectsDataset, () => {
    afterEach(() => {
        resetDurableObjectsProbe();
    });

    it("discovers the dataset that reports rows, by introspection, and remembers it for the isolate", async () => {
        const seen: string[] = [];
        const fetch = fakeCloudflare({
            graphql: fakeGraphql(
                {
                    durableObjectsInvocationsAdaptiveGroups: { dimensions: ["scriptName", "datetimeHour"], filter: HOURLY_FILTER, sum: ["requests"] },
                    durableObjectsPeriodicGroups: {
                        dimensions: ["namespaceId", "datetimeHour"],
                        filter: HOURLY_FILTER,
                        sum: ["rowsRead", "rowsWritten", "cpuTime"],
                    },
                },
                [],
                seen,
            ),
        });

        await expect(probeDurableObjectsDataset(access(fetch))).resolves.toStrictEqual({
            by: "namespaceId",
            field: "durableObjectsPeriodicGroups",
            filter: "hour",
            sums: ["rowsRead", "rowsWritten"],
        });

        const calls = fetch.mock.calls.length;

        await probeDurableObjectsDataset(access(fetch));

        expect(fetch).toHaveBeenCalledTimes(calls);
        // Nothing but introspection was sent: no data query names a field the schema did not offer.
        expect(seen.every((query) => query.includes("__schema") || query.includes("__type"))).toBe(true);
    });

    it("reports a schema with no Durable Objects dataset as unavailable, and remembers that too", async () => {
        const fetch = fakeCloudflare({ graphql: fakeGraphql({}) });

        await expect(probeDurableObjectsDataset(access(fetch))).rejects.toThrow(UsageUnavailableError);

        const calls = fetch.mock.calls.length;

        await expect(probeDurableObjectsDataset(access(fetch))).rejects.toThrow(/no durableObjects\* dataset/u);
        expect(fetch).toHaveBeenCalledTimes(calls);
    });

    it("never prices 4 KB storage units as rows: a dataset with only those is unavailable, and says what it has", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql({
                durableObjectsStorageGroups: { dimensions: ["scriptName"], filter: HOURLY_FILTER, sum: ["storageReadUnits", "storageWriteUnits"] },
            }),
        });

        const failure = await probeDurableObjectsDataset(access(fetch)).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(UsageUnavailableError);
        expect(String(failure)).toContain("durableObjectsStorageGroups (sum: storageReadUnits, storageWriteUnits; dimensions: scriptName)");
    });

    it("does not remember a refused token, so fixing the token takes effect without a new isolate", async () => {
        let refuse = true;
        const answer = fakeGraphql({ durableObjectsPeriodicGroups: { dimensions: ["scriptName"], filter: HOURLY_FILTER, sum: ["rowsRead"] } });
        const fetch = fakeCloudflare({ graphql: (request) => (refuse ? { status: 403 } : answer(request)) });

        await expect(probeDurableObjectsDataset(access(fetch))).rejects.toBeInstanceOf(CloudflareTokenError);

        refuse = false;

        await expect(probeDurableObjectsDataset(access(fetch))).resolves.toMatchObject({ by: "scriptName", sums: ["rowsRead"] });
    });
});

describe(readDurableObjectUsageByScript, () => {
    afterEach(() => {
        resetDurableObjectsProbe();
    });

    it("sums the rows per script over the closed hours of the window", async () => {
        const seen: string[] = [];
        const fetch = fakeCloudflare({
            graphql: fakeGraphql(
                { durableObjectsPeriodicGroups: { dimensions: ["scriptName"], filter: HOURLY_FILTER, sum: ["rowsRead", "rowsWritten"] } },
                [
                    { dimensions: { scriptName: "shop" }, sum: { rowsRead: 4_000_000_000, rowsWritten: 2_000_000 } },
                    { dimensions: { scriptName: "blog" }, sum: { rowsRead: 12, rowsWritten: 0 } },
                ],
                seen,
            ),
        });

        const usage = await readDurableObjectUsageByScript(access(fetch), WINDOW);

        expect(Object.fromEntries(usage)).toStrictEqual({
            // A zero meter is left out, as the rollback would write nothing for it.
            blog: { doRowsRead: 12 },
            shop: { doRowsRead: 4_000_000_000, doRowsWritten: 2_000_000 },
        });

        const data = seen.find((query) => query.includes("LunoraDurableObjectRows")) ?? "";

        expect(data).toContain("rows: durableObjectsPeriodicGroups(");
        expect(data).toContain(`datetimeHour_leq: ${JSON.stringify(new Date(WINDOW.untilMs - HOUR).toISOString())}`);
        expect(data).toContain("dimensions { scriptName }");
    });

    it("resolves namespace ids through the namespace list, drops another dispatch namespace's, and keys an unknown one visibly", async () => {
        const fetch = fakeCloudflare({
            graphql: fakeGraphql({ durableObjectsPeriodicGroups: { dimensions: ["namespaceId"], filter: HOURLY_FILTER, sum: ["rowsRead", "rowsWritten"] } }, [
                { dimensions: { namespaceId: "ns-shop" }, sum: { rowsRead: 10, rowsWritten: 1 } },
                { dimensions: { namespaceId: "ns-staging" }, sum: { rowsRead: 99, rowsWritten: 9 } },
                { dimensions: { namespaceId: "ns-gone" }, sum: { rowsRead: 5, rowsWritten: 0 } },
            ]),
            rest: {
                [`/accounts/${ACCOUNT}/workers/durable_objects/namespaces`]: () => {
                    return {
                        result: [
                            { class: "ShardDO", dispatch_namespace: "lunora-production", id: "ns-shop", name: "shop_ShardDO", script: "shop" },
                            { class: "ShardDO", dispatch_namespace: "lunora-staging", id: "ns-staging", name: "x_ShardDO", script: "shop" },
                        ],
                    };
                },
            },
        });

        const usage = await readDurableObjectUsageByScript(access(fetch), WINDOW, { dispatchNamespace: "lunora-production" });

        expect(Object.fromEntries(usage)).toStrictEqual({
            "namespace:ns-gone": { doRowsRead: 5 },
            shop: { doRowsRead: 10, doRowsWritten: 1 },
        });
    });

    it("throws the probe's reason instead of reading zero when no dataset can be metered", async () => {
        const fetch = fakeCloudflare({ graphql: fakeGraphql({}) });

        await expect(readDurableObjectUsageByScript(access(fetch), WINDOW)).rejects.toBeInstanceOf(UsageUnavailableError);
    });
});

describe("the readback fleets' storage families", () => {
    it("are wired from the cell's account credentials on cloudflare-wfp, and absent without them", () => {
        const configured = cloudflareWfpFleetFromEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, LUNORA_CELL: "eu-1" });

        expect(Object.keys(configured.usage?.sources ?? {}).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["d1", "durableObjects", "requests"]);
        expect(configured.usage?.sources.d1?.cadence).toBe("hourly");
        expect(cloudflareWfpFleetFromEnv({ LUNORA_CELL: "eu-1" }).usage).toBeUndefined();
    });

    it("report a token the cell's account refuses as unavailable, not as a failure to retry", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ errors: [{ message: "Authentication error" }], success: false }, { status: 403 }))),
        );

        try {
            const fleet = cloudflareWfpFleetFromEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, LUNORA_CELL: "eu-1" });
            const failure = await fleet.usage?.sources.d1?.read("eu-1", WINDOW).catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(UsageUnavailableError);
            expect(String(failure)).toContain("Cloudflare refused the token");
            expect(String(failure)).not.toContain(TOKEN);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("report a query Cloudflare rejects (here: introspection) as unavailable, and a 502 as a failure to retry", async () => {
        let status = 200;

        vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(() =>
                Promise.resolve(Response.json({ data: null, errors: status === 200 ? [{ message: "introspection is disabled" }] : null }, { status })),
            ),
        );

        try {
            const fleet = cloudflareWfpFleetFromEnv({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN, LUNORA_CELL: "eu-1" });
            const rejected = await fleet.usage?.sources.durableObjects?.read("eu-1", WINDOW).catch((error: unknown) => error);

            expect(rejected).toBeInstanceOf(UsageUnavailableError);
            expect(String(rejected)).toContain("introspection is disabled");

            status = 502;

            const failed = await fleet.usage?.sources.durableObjects?.read("eu-1", WINDOW).catch((error: unknown) => error);

            expect(failed).toBeInstanceOf(Error);
            expect(failed).not.toBeInstanceOf(UsageUnavailableError);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("are wired for every connected account on cloudflare-workers", () => {
        expect(Object.keys(cloudflareWorkersFleetFromEnv({}).usage?.sources ?? {}).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "d1",
            "durableObjects",
            "requests",
        ]);
    });

    it("read only this cell's scope, and name a cloudflare-wfp tenant's resources by its alias", async () => {
        const d1 = vi.fn<(window: UsageWindow) => Promise<Map<string, PeriodUsage>>>(() => Promise.resolve(new Map([["shop", { d1RowsRead: 5 }]])));
        const { usage } = createCloudflareWfpFleet({ cell: "eu-1", storage: { d1, durableObjects: () => Promise.resolve(new Map()) } });

        await expect(usage?.sources.d1?.read("eu-1", WINDOW)).resolves.toStrictEqual([{ meters: { d1RowsRead: 5 }, resourceRef: "shop" }]);
        await expect(usage?.sources.d1?.read("us-1", WINDOW)).resolves.toStrictEqual([]);
        expect(d1).toHaveBeenCalledTimes(1);
        // Storage alone still makes the fleet a readback fleet; request counts are a separate family.
        expect(usage?.sources.requests).toBeUndefined();
    });

    it("qualify a connected account's resources by the account, and read only metered accounts with their own token", async () => {
        const durableObjects = vi.fn<(credentials: { apiToken: string }) => Promise<Map<string, PeriodUsage>>>((credentials) =>
            Promise.resolve(new Map([["web", { doRowsWritten: credentials.apiToken.length }]])),
        );
        const { usage } = createCloudflareWorkersFleet({
            accounts: () => Promise.resolve(["cfa_1"]),
            credentials: () => Promise.resolve({ accountId: ACCOUNT, apiToken: "tok" }),
            read: () => Promise.resolve([]),
            storage: { d1: () => Promise.resolve(new Map()), durableObjects },
        });

        await expect(usage?.sources.durableObjects?.read("cfa_1", WINDOW)).resolves.toStrictEqual([
            { meters: { doRowsWritten: 3 }, resourceRef: resourceRefOf({ placementRef: "cfa_1", target: "cloudflare-workers" }, "web") },
        ]);
        await expect(usage?.sources.durableObjects?.read("cfa_9", WINDOW)).resolves.toStrictEqual([]);
        expect(durableObjects).toHaveBeenCalledTimes(1);
    });
});

describe(meteringNotices, () => {
    const accounts = [{ _id: "cfa_1", label: "Acme prod" }];

    it("words the platform's own source for the customer, and shows a connected account's reason under its label", () => {
        expect(
            meteringNotices(
                [
                    { scopeKey: "default#durableObjects", target: "cloudflare-wfp", unavailableReason: "storage metering unavailable: token refused" },
                    { scopeKey: "cfa_1#d1", target: "cloudflare-workers", unavailableReason: "storage metering unavailable: the token cannot read D1" },
                    { scopeKey: "cfa_1", target: "cloudflare-workers", unavailableReason: null },
                ],
                accounts,
                "default",
            ),
        ).toStrictEqual([
            {
                family: "durableObjects",
                message:
                    "Lunora Cloud cannot read this usage right now: Durable Object rows read and written are not counted toward your usage or spend cap until it can.",
                source: "Lunora Cloud",
            },
            {
                family: "d1",
                message: "storage metering unavailable: the token cannot read D1 (D1 rows read and written are not counted)",
                source: "Acme prod",
            },
        ]);
    });

    it("never shows another organization's account, or another cell's platform source", () => {
        expect(meteringNotices([{ scopeKey: "cfa_2#d1", target: "cloudflare-workers", unavailableReason: "x" }], accounts, "default")).toStrictEqual([]);
        expect(meteringNotices([{ scopeKey: "eu-1#d1", target: "cloudflare-wfp", unavailableReason: "x" }], accounts, "default")).toStrictEqual([]);
    });

    it("reads the family off the scope key, and a bare scope as request counts", () => {
        expect(parseScopeKey("default")).toStrictEqual({ family: "requests", scope: "default" });
        expect(parseScopeKey("cfa_1#durableObjects")).toStrictEqual({ family: "durableObjects", scope: "cfa_1" });
        expect(parseScopeKey("odd#thing")).toStrictEqual({ family: "requests", scope: "odd#thing" });
    });
});
