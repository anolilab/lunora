/* eslint-disable no-secrets/no-secrets -- GraphQL dataset and operation names read as entropy; none is a credential */

/**
 * A fake Cloudflare API for the usage readers' suites: REST listings by path,
 * and a GraphQL schema described by its datasets, answered to introspection.
 */
import type { Mock } from "vitest";
import { vi } from "vitest";

export const ACCOUNT = "a".repeat(32);
export const TOKEN = "cf-token-that-must-never-leak-0123456789";
export const HOUR = 60 * 60 * 1000;
/** A closed, hour-aligned window: 09:00–11:00 on 15 June. */
export const WINDOW = { sinceMs: Date.UTC(2026, 5, 15, 9), untilMs: Date.UTC(2026, 5, 15, 11) };

export interface GraphqlRequest {
    query: string;
    variables: Record<string, unknown>;
}

/** A fake Cloudflare API: REST listings by path, and every GraphQL request handed to `graphql`. */
export const fakeCloudflare = (options: {
    graphql: (request: GraphqlRequest) => { data?: unknown; errors?: { message: string }[]; status?: number };
    rest?: Record<string, (page: number, perPage: number) => { result: unknown[]; resultInfo?: Record<string, number> } | { status: number }>;
}): Mock<typeof fetch> =>
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

        const answer = listing(Number(url.searchParams.get("page") ?? "1"), Number(url.searchParams.get("per_page") ?? "20"));

        return "status" in answer
            ? Response.json({ errors: [{ message: "Authentication error" }], success: false }, { status: answer.status })
            : Response.json({ result: answer.result, ...(answer.resultInfo === undefined ? {} : { result_info: answer.resultInfo }), success: true });
    });

export const access = (fetch: typeof globalThis.fetch): { accountId: string; apiToken: string; fetch: typeof globalThis.fetch } => {
    return { accountId: ACCOUNT, apiToken: TOKEN, fetch };
};

/** One `durableObjects*` dataset of the fake schema. */
export interface DatasetShape {
    dimensions: string[];
    filter: string[];
    /** A sum field's name, or its name with the schema's description of it. */
    sum: (string | { description: string; name: string })[];
}

export const named = (name: string): { kind: string; name: string; ofType: null } => {
    return { kind: "OBJECT", name, ofType: null };
};

/**
 * A GraphQL schema as introspection describes it: `Query.viewer: Viewer!`,
 * `Viewer.accounts: [Account]`, and on `Account` one field per dataset.
 */
export const schemaTypes = (datasets: Record<string, DatasetShape>): Record<string, unknown> => {
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
            fields: shape.sum.map((field) => (typeof field === "string" ? { name: field } : field)),
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
export const fakeGraphql =
    (datasets: Record<string, DatasetShape>, rows: unknown[] = [], seen: string[] = []) =>
    ({ query }: GraphqlRequest): { data: unknown } => {
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

export const HOURLY_FILTER = ["datetimeHour_geq", "datetimeHour_leq", "scriptName"];
/** The Durable Object namespace listing of the account. */
export const NAMESPACES = `/accounts/${ACCOUNT}/workers/durable_objects/namespaces`;

/** A namespace as the listing reports it; `dispatchNamespace` only for a Workers-for-Platforms user script's. */
export const namespace = (id: string, script: string, dispatchNamespace?: string): Record<string, string> => {
    return { class: "ShardDO", id, name: `${script}_ShardDO`, script, ...(dispatchNamespace === undefined ? {} : { dispatch_namespace: dispatchNamespace }) };
};
