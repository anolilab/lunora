/* eslint-disable no-secrets/no-secrets -- GraphQL dataset, field and operation names read as entropy; none is a credential */

/**
 * Storage row counts read back from a Cloudflare account: D1 and Durable
 * Object rows read and written, per tenant. These are the two meters a Durable
 * Object alarm stuck in a loop runs up without serving a single request, so
 * request counts alone never see that runaway.
 *
 * Both readers work against any account. They read the platform's own cell
 * account for `cloudflare-wfp`, and a connected customer account for
 * `cloudflare-workers`. Both read Cloudflare's hourly-bucketed GraphQL datasets,
 * so the rollback calls them with closed, hour-aligned windows only.
 *
 * - **D1.** The dataset is `d1AnalyticsAdaptiveGroups`. Its filter (`databaseId`,
 *   `datetimeHour_geq`, `datetimeHour_leq`), its sum fields and the
 *   `datetimeHour` dimension are the ones wrangler's own `d1 info` query uses.
 *   `databaseId` is not proven to be a dimension, so each database is queried
 *   by filter instead. The databases are batched into one request with GraphQL
 *   field aliases. A database is attributed by its name: tenant resources are
 *   named `{alias}--{binding}` (`tenantResourceName`), and
 *   `aliasOfResourceName` reverses that.
 * - **Durable Objects.** No field name of the Durable Objects datasets is
 *   verified anywhere in this repository. So the dataset is discovered by
 *   introspection ({@link probeDurableObjectsDataset}) rather than hard-coded.
 *   The probe takes `rowsRead` / `rowsWritten` only where the schema has them,
 *   and attributes by `scriptName`, or by `namespaceId` resolved through the
 *   namespace list. When the schema offers no such dataset, the reader throws
 *   `UsageUnavailableError` with the reason, and the sweep shows it. It never
 *   reports zero instead.
 */
import type { PeriodUsage } from "../billing/spend";
import { UsageUnavailableError } from "../metering/unavailable";
import { aliasOfResourceName } from "../provision-contract";
import type { UsageWindow } from "../targets/driver";
import type { CloudflareAccountAccess } from "./fetch";
import { cloudflareFetch, CloudflareTokenError } from "./fetch";
import { cloudflareGraphql, CloudflareGraphqlQueryError, graphqlTime } from "./graphql";

const HOUR_MS = 60 * 60 * 1000;

/** The row limit every grouped query asks for. A result this long may be truncated, so it is refused. */
export const STORAGE_QUERY_LIMIT = 10_000;

/** Databases per GraphQL request. */
export const D1_QUERY_BATCH = 25;

/** Pages any one listing reads at most, so a broken `total_pages` cannot loop forever. */
const MAX_LIST_PAGES = 100;

/** A positive, finite count; anything else is nothing. */
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Add `usage` into `into` under `key`. */
const addUsage = (into: Map<string, PeriodUsage>, key: string, usage: PeriodUsage): void => {
    const total = into.get(key) ?? {};

    for (const [meter, quantity] of Object.entries(usage) as [keyof PeriodUsage, number][]) {
        if (quantity > 0) {
            total[meter] = (total[meter] ?? 0) + quantity;
        }
    }

    into.set(key, total);
};

/** Items asked for per page of a listing. */
const LIST_PAGE_SIZE = 100;

/**
 * Every item of a page-numbered v4 listing. It pages until a page comes back
 * short (fewer items than the page size the envelope reports, or than asked
 * for), or `total_count` is reached. `total_pages` is not trusted: listings
 * such as D1's do not always send it, and a missing one read as "1 page" metered
 * only the first hundred databases.
 * @throws {UsageUnavailableError} past {@link MAX_LIST_PAGES} full pages — a
 * partial list would silently drop tenants, so it is reported instead.
 */
export const listAll = async <T>(access: CloudflareAccountAccess, path: string): Promise<T[]> => {
    const call = cloudflareFetch(access);
    const items: T[] = [];

    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- page-numbered listing is sequential by construction
        const answer = await call<T[]>(`${path}${path.includes("?") ? "&" : "?"}page=${String(page)}&per_page=${String(LIST_PAGE_SIZE)}`);
        const result = answer?.result ?? [];

        items.push(...result);

        const complete = answer?.totalCount === undefined ? result.length < (answer?.perPage ?? LIST_PAGE_SIZE) : items.length >= answer.totalCount;

        if (result.length === 0 || complete) {
            return items;
        }
    }

    throw new UsageUnavailableError(
        `the listing ${path.split("?")[0] ?? path} has more than ${String(MAX_LIST_PAGES * LIST_PAGE_SIZE)} entries; refusing to meter a partial list`,
    );
};

/** A D1 database as the listing reports it. */
export interface D1DatabaseRef {
    name: string;
    uuid: string;
}

/** Every D1 database in the account (`GET /accounts/{id}/d1/database`, D1 Read). */
export const listD1Databases = async (access: CloudflareAccountAccess): Promise<D1DatabaseRef[]> => {
    const rows = await listAll<{ name?: unknown; uuid?: unknown }>(access, `/accounts/${access.accountId}/d1/database`);

    return rows.flatMap((row) => (typeof row.name === "string" && typeof row.uuid === "string" ? [{ name: row.name, uuid: row.uuid }] : []));
};

interface D1Group {
    dimensions?: { datetimeHour?: string };
    sum?: { rowsRead?: number; rowsWritten?: number };
}

/** The hour filter of a closed `[since, until)` window: `datetimeHour_leq` is inclusive, so it names the last hour. */
const hourFilter = (window: UsageWindow, geq: string, leq: string): string =>
    `${geq}: ${JSON.stringify(graphqlTime(window.sinceMs))}, ${leq}: ${JSON.stringify(graphqlTime(window.untilMs - HOUR_MS))}`;

/** One batch of databases, as a query with one aliased field per database. */
const d1BatchQuery = (batch: ReadonlyArray<D1DatabaseRef>, window: UsageWindow): string => {
    const fields = batch.map(
        (database, index) =>
            `d${String(index)}: d1AnalyticsAdaptiveGroups(limit: ${String(STORAGE_QUERY_LIMIT)}, filter: { databaseId: ${JSON.stringify(database.uuid)}, ${hourFilter(window, "datetimeHour_geq", "datetimeHour_leq")} }) { sum { rowsRead rowsWritten } dimensions { datetimeHour } }`,
    );

    return `query LunoraD1Rows($accountTag: string!) { viewer { accounts(filter: { accountTag: $accountTag }) { ${fields.join(" ")} } } }`;
};

/**
 * D1 rows read and written per tenant alias in a closed, hour-aligned window
 * (`[sinceMs, untilMs)`). Databases whose name no tenant produced (the
 * platform's own) are not read.
 * @throws {CloudflareTokenError} when the token lacks D1 Read or Account Analytics Read.
 */
export const readD1UsageByAlias = async (access: CloudflareAccountAccess, window: UsageWindow): Promise<Map<string, PeriodUsage>> => {
    const databases = await listD1Databases(access);
    const tenants = databases.flatMap((database) => {
        const alias = aliasOfResourceName(database.name);

        return alias === undefined ? [] : [{ ...database, alias }];
    });
    const byAlias = new Map<string, PeriodUsage>();

    for (let start = 0; start < tenants.length; start += D1_QUERY_BATCH) {
        const batch = tenants.slice(start, start + D1_QUERY_BATCH);
        // eslint-disable-next-line no-await-in-loop -- one request per batch, sequential to stay polite to the API
        const data = await cloudflareGraphql<{ viewer?: { accounts?: Record<string, D1Group[] | undefined>[] } }>(access, d1BatchQuery(batch, window), {
            accountTag: access.accountId,
        });
        const account = data.viewer?.accounts?.[0] ?? {};

        for (const [index, database] of batch.entries()) {
            const groups = account[`d${String(index)}`] ?? [];

            if (groups.length >= STORAGE_QUERY_LIMIT) {
                throw new Error(`D1 analytics for ${database.name} hit the ${String(STORAGE_QUERY_LIMIT)}-row limit; refusing a truncated count`);
            }

            addUsage(byAlias, database.alias, {
                d1RowsRead: groups.reduce((sum, group) => sum + count(group.sum?.rowsRead), 0),
                d1RowsWritten: groups.reduce((sum, group) => sum + count(group.sum?.rowsWritten), 0),
            });
        }
    }

    return byAlias;
};

/** A Durable Object namespace as the listing reports it. */
export interface DurableObjectNamespaceRef {
    /** The dispatch namespace of a Workers-for-Platforms user script's namespace. */
    dispatchNamespace?: string;
    id: string;
    script?: string;
}

/** Every Durable Object namespace in the account (`GET /accounts/{id}/workers/durable_objects/namespaces`, Workers Scripts Read). */
export const listDurableObjectNamespaces = async (access: CloudflareAccountAccess): Promise<DurableObjectNamespaceRef[]> => {
    const rows = await listAll<{ dispatch_namespace?: unknown; id?: unknown; script?: unknown }>(
        access,
        `/accounts/${access.accountId}/workers/durable_objects/namespaces`,
    );

    return rows.flatMap((row) =>
        typeof row.id === "string"
            ? [
                  {
                      id: row.id,
                      ...(typeof row.script === "string" ? { script: row.script } : {}),
                      ...(typeof row.dispatch_namespace === "string" ? { dispatchNamespace: row.dispatch_namespace } : {}),
                  },
              ]
            : [],
    );
};

/** A unit a schema description can state. */
export type StatedUnit = "gbSeconds" | "microseconds" | "milliseconds" | "nanoseconds" | "seconds";

/**
 * How each unit is spelled, in the order they are looked for. A match is cut
 * out of the text before the next is tried, so the "seconds" of
 * "GB-seconds" or "microseconds" is not counted again as plain seconds.
 */
const UNIT_SPELLINGS: ReadonlyArray<[StatedUnit, RegExp]> = [
    ["gbSeconds", /\bGB\W{0,3}s(?:ec(?:ond)?s?)?\b|gigabyte\W{0,3}seconds?/giu],
    ["microseconds", /microseconds?|µs\b/giu],
    ["milliseconds", /milliseconds?|\bms\b/giu],
    ["nanoseconds", /nanoseconds?|\bns\b/giu],
    ["seconds", /\bsec(?:ond)?s?\b/giu],
];

/** Every unit a description names. */
export const statedUnits = (description: string): Set<StatedUnit> => {
    const units = new Set<StatedUnit>();
    let rest = description;

    for (const [unit, spelling] of UNIT_SPELLINGS) {
        const next = rest.replaceAll(spelling, " ");

        if (next !== rest) {
            units.add(unit);
            rest = next;
        }
    }

    return units;
};

/** One sum field a probe looks for. */
export interface SumWant<TSum extends string = string> {
    name: TSum;

    /**
     * The unit the field's schema description must state, and state alone, for
     * it to be taken, when the name does not say. A description naming no unit,
     * another one, or more than one ("seconds; multiply by 0.125 GB for GB-s",
     * "milliseconds (was microseconds)") is left alone and reported, never read
     * in a unit we guessed.
     */
    unit?: StatedUnit;
}

/**
 * What a probe looks for: a dataset field on the account type, starting with
 * `prefix`, whose group has at least one of `sums`, one of the attribution
 * `dimensions` (in order of preference), and an hour or instant time filter.
 */
export interface DatasetSpec<TSum extends string = string, TBy extends string = string> {
    by: ReadonlyArray<TBy>;
    /** Names the probe in its cache, so two probes of one account never overwrite each other. */
    key: string;

    /** The product, as the unavailable message names it ("Durable Objects"). */
    label: string;

    /**
     * A dimension that names the dispatch namespace of a row, when the dataset
     * has one: `name` exactly when the schema has it, else the first that
     * matches `pattern`. Reported as {@link ProbedDataset.namespace}; never
     * required by the probe — the reader decides whether it can do without it.
     */
    namespaceDimension?: { name: string; pattern: RegExp };
    /** The datasets tried first, in this order. Any other `prefix*` field follows, alphabetically. */
    preferred: ReadonlyArray<string>;
    prefix: string;
    /** What the dataset must report, as the unavailable message says it. */
    requirement: string;
    sums: ReadonlyArray<SumWant<TSum>>;
}

/** A dataset a probe found that can be metered, and how to query it. */
export interface ProbedDataset<TSum extends string = string, TBy extends string = string> {
    /** The dimension rows are attributed by. */
    by: TBy;
    /** The dataset's field on the account type, e.g. `durableObjectsPeriodicGroups`. */
    field: string;
    /** The time filter: `hour` filters `datetimeHour_geq/_leq`, `instant` filters `datetime_geq/_leq`. */
    filter: "hour" | "instant";
    /** The dispatch-namespace dimension ({@link DatasetSpec.namespaceDimension}), when the dataset has one. */
    namespace?: string;
    /** The wanted sum fields the dataset has, in the order the spec lists them. */
    sums: TSum[];
}

/** A Durable Objects dataset the probe found that reports rows, and how to query it. */
export type DurableObjectsDataset = ProbedDataset<"rowsRead" | "rowsWritten", "namespaceId" | "scriptName">;

interface TypeRef {
    kind?: string;
    name?: null | string;
    ofType?: null | TypeRef;
}

interface IntrospectedField {
    args?: { name: string; type: TypeRef }[];
    name: string;
    type: TypeRef;
}

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";

/** The named type under any `NON_NULL` / `LIST` wrappers. */
const namedType = (ref: TypeRef | null | undefined): string | undefined => {
    for (let current = ref; current; current = current.ofType) {
        if (typeof current.name === "string" && current.name !== "") {
            return current.name;
        }
    }

    return undefined;
};

/** What a GraphQL type name may be. */
const TYPE_NAME = /^\w+$/u;

/** A type name as a GraphQL string argument; names come from the schema, but are checked before they are put in a query. */
const typeName = (name: string): string => {
    if (!TYPE_NAME.test(name)) {
        throw new Error(`unexpected GraphQL type name ${JSON.stringify(name.slice(0, 64))}`);
    }

    return JSON.stringify(name);
};

/**
 * The Durable Objects datasets that report rows: tried first, in this order.
 * Any other `durableObjects*` field follows, alphabetically.
 */
const DURABLE_OBJECTS_ROWS: DatasetSpec<"rowsRead" | "rowsWritten", "namespaceId" | "scriptName"> = {
    // A namespace id names one namespace; a script name can be shared across dispatch namespaces.
    by: ["namespaceId", "scriptName"],
    key: "durableObjects:rows",
    label: "Durable Objects",
    preferred: ["durableObjectsPeriodicGroups", "durableObjectsInvocationsAdaptiveGroups"],
    prefix: "durableObjects",
    requirement: "rowsRead/rowsWritten with a scriptName or namespaceId dimension",
    sums: [{ name: "rowsRead" }, { name: "rowsWritten" }],
};

/** Fields of the given types, read in one aliased introspection request. */
const typeFields = async (access: CloudflareAccountAccess, names: ReadonlyArray<string>, selection: string): Promise<Record<string, unknown>> => {
    if (names.length === 0) {
        return {};
    }

    const fields = names.map((name, index) => `t${String(index)}: __type(name: ${typeName(name)}) { ${selection} }`);

    return cloudflareGraphql<Record<string, unknown>>(access, `query LunoraIntrospect { ${fields.join(" ")} }`);
};

/** How long the isolate trusts a probe's outcome before asking the schema again. */
export const PROBE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * The schema discovery's outcome per account and probe — the dataset, or why
 * there is none — with when it was found. Per account, so one account's schema
 * (or plan) never decides another's, per probe ({@link DatasetSpec.key}), so the
 * rows probe and the CPU probe of one account never overwrite each other, and
 * for {@link PROBE_TTL_MS} only, so a schema that gains the dataset is noticed
 * without a new isolate.
 */
const probed = new Map<string, { at: number; outcome: ProbedDataset | UsageUnavailableError }>();

/** Forget every probe outcome — for tests, which each describe their own schema. */
export const resetDurableObjectsProbe = (): void => {
    probed.clear();
};

/** Walk the schema to the account type: `Query.viewer` → `.accounts` → its element type. */
const accountTypeName = async (access: CloudflareAccountAccess): Promise<string> => {
    const { __schema: schema } = await cloudflareGraphql<{ __schema?: { queryType?: { fields?: IntrospectedField[] } } }>(
        access,
        `query LunoraIntrospect { __schema { queryType { fields { name type { ${TYPE_REF} } } } } }`,
    );
    const viewer = namedType(schema?.queryType?.fields?.find((field) => field.name === "viewer")?.type);

    if (viewer === undefined) {
        throw new UsageUnavailableError("the GraphQL schema has no `viewer` field");
    }

    const { t0: viewerFields } = (await typeFields(access, [viewer], `fields { name type { ${TYPE_REF} } }`)) as {
        t0?: { fields?: IntrospectedField[] } | null;
    };
    const account = namedType(viewerFields?.fields?.find((field) => field.name === "accounts")?.type);

    if (account === undefined) {
        throw new UsageUnavailableError("the GraphQL schema's `viewer` has no `accounts` field");
    }

    return account;
};

/** A described type's fields: names, with their descriptions. */
type Described = Map<string, string | undefined>;

/** The wanted sums a dataset has — a unit-checked one only when its description states the unit — and the ones it has in an unstated unit. */
const wantedSums = <TSum extends string>(spec: DatasetSpec<TSum>, sums: Described): { present: TSum[]; unstated: string[] } => {
    const present: TSum[] = [];
    const unstated: string[] = [];

    for (const want of spec.sums) {
        if (!sums.has(want.name)) {
            continue;
        }

        const description = sums.get(want.name) ?? "";
        const units = statedUnits(description);
        const quoted = description === "" ? "no description" : JSON.stringify(description.slice(0, 80));

        if (want.unit === undefined || (units.size === 1 && units.has(want.unit))) {
            present.push(want.name);
        } else {
            unstated.push(units.size > 1 ? `${want.name} names more than one unit (${quoted})` : `${want.name} does not state its unit (${quoted})`);
        }
    }

    return { present, unstated };
};

/** The time filter a filter type offers, if any. */
const timeFilterOf = (filters: Described): ProbedDataset["filter"] | undefined => {
    if (filters.has("datetimeHour_geq") && filters.has("datetimeHour_leq")) {
        return "hour";
    }

    return filters.has("datetime_geq") && filters.has("datetime_leq") ? "instant" : undefined;
};

/**
 * The dispatch-namespace dimension of a dataset: the exact name the spec
 * prefers (`dispatchNamespaceName`) over any other that matches its pattern,
 * so a `dispatchNamespaceId` listed first is not taken for the name.
 */
const namespaceDimensionOf = (spec: DatasetSpec, dimensions: Described): string | undefined => {
    const wanted = spec.namespaceDimension;

    if (wanted === undefined) {
        return undefined;
    }

    return dimensions.has(wanted.name) ? wanted.name : [...dimensions.keys()].find((dimension) => wanted.pattern.test(dimension));
};

/** Pick the dataset to meter from what the schema describes, or say why none fits. */
const chooseDataset = async <TSum extends string, TBy extends string>(
    access: CloudflareAccountAccess,
    spec: DatasetSpec<TSum, TBy>,
    candidates: ReadonlyArray<IntrospectedField>,
): Promise<ProbedDataset<TSum, TBy>> => {
    const groups = candidates.map((field) => {
        return { field: field.name, filter: namedType(field.args?.find((argument) => argument.name === "filter")?.type), group: namedType(field.type) };
    });
    const groupTypes = await typeFields(
        access,
        groups.map(({ group }) => group ?? "Unknown"),
        `fields { name type { ${TYPE_REF} } }`,
    );
    const shapes = groups.map(({ field, filter }, index) => {
        const fields = (groupTypes[`t${String(index)}`] as { fields?: IntrospectedField[] } | null)?.fields ?? [];

        return {
            dimensions: namedType(fields.find((candidate) => candidate.name === "dimensions")?.type),
            field,
            filter,
            sum: namedType(fields.find((candidate) => candidate.name === "sum")?.type),
        };
    });
    // One request for every sum, dimensions and filter type, in that order per dataset.
    const names = shapes.flatMap((shape) => [shape.sum ?? "Unknown", shape.dimensions ?? "Unknown", shape.filter ?? "Unknown"]);
    const described = await typeFields(access, names, "fields { name description } inputFields { name }");
    const fieldsOf = (index: number): Described => {
        const type = described[`t${String(index)}`] as {
            fields?: { description?: null | string; name: string }[] | null;
            inputFields?: { name: string }[] | null;
        } | null;

        return new Map<string, string | undefined>([
            ...(type?.fields ?? []).map((field): [string, string | undefined] => [field.name, field.description ?? undefined]),
            ...(type?.inputFields ?? []).map((field): [string, string | undefined] => [field.name, undefined]),
        ]);
    };
    const seen: string[] = [];

    for (const [index, shape] of shapes.entries()) {
        const sums = fieldsOf(index * 3);
        const dimensions = fieldsOf(index * 3 + 1);
        const filter = timeFilterOf(fieldsOf(index * 3 + 2));
        const { present, unstated } = wantedSums(spec, sums);
        const by = spec.by.find((dimension) => dimensions.has(dimension));
        const namespace = namespaceDimensionOf(spec, dimensions);

        if (present.length > 0 && filter !== undefined && by !== undefined) {
            return { by, field: shape.field, filter, ...(namespace === undefined ? {} : { namespace }), sums: present };
        }

        seen.push(
            `${shape.field} (sum: ${[...sums.keys()].join(", ") || "none"}; dimensions: ${[...dimensions.keys()].join(", ") || "none"}${unstated.length > 0 ? `; ${unstated.join("; ")}` : ""})`,
        );
    }

    throw new UsageUnavailableError(
        `no ${spec.label} dataset reports ${spec.requirement} and an hour filter; seen: ${seen.join("; ") || "none"}`.slice(0, 500),
    );
};

/**
 * Find the dataset `spec` describes by GraphQL introspection, and remember the
 * answer for the account and spec, for {@link PROBE_TTL_MS}.
 *
 * Only what the schema says is remembered: a dataset, or a definitive "none".
 * A refused token or a failed request is not cached. Otherwise a fixed token
 * would stay "unavailable" for as long as the isolate lives.
 * @throws {UsageUnavailableError} when the schema offers no dataset to meter.
 * @throws {CloudflareTokenError} when the token is refused.
 */
export const probeDataset = async <TSum extends string, TBy extends string>(
    access: CloudflareAccountAccess,
    spec: DatasetSpec<TSum, TBy>,
    now = Date.now(),
): Promise<ProbedDataset<TSum, TBy>> => {
    const cacheKey = `${spec.key}:${access.accountId}`;
    const known = probed.get(cacheKey);

    if (known !== undefined && now - known.at < PROBE_TTL_MS) {
        if (known.outcome instanceof UsageUnavailableError) {
            throw known.outcome;
        }

        // Stored under this spec's own key, so it is this spec's dataset.
        return known.outcome as ProbedDataset<TSum, TBy>;
    }

    try {
        const account = await accountTypeName(access);
        const { t0: accountType } = (await typeFields(access, [account], `fields { name type { ${TYPE_REF} } args { name type { ${TYPE_REF} } } }`)) as {
            t0?: { fields?: IntrospectedField[] } | null;
        };
        const rank = (name: string): number => {
            const index = spec.preferred.indexOf(name);

            return index === -1 ? spec.preferred.length : index;
        };
        const candidates = (accountType?.fields ?? [])
            .filter((field) => field.name.startsWith(spec.prefix))
            .toSorted((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));

        if (candidates.length === 0) {
            throw new UsageUnavailableError(`the GraphQL account type ${account} has no ${spec.prefix}* dataset`);
        }

        const dataset = await chooseDataset(access, spec, candidates);

        probed.set(cacheKey, { at: now, outcome: dataset });

        return dataset;
    } catch (error) {
        if (error instanceof UsageUnavailableError) {
            probed.set(cacheKey, { at: now, outcome: error });
        }

        throw error;
    }
};

/**
 * Find the Durable Objects dataset that reports rows read and written, by
 * GraphQL introspection ({@link probeDataset}).
 *
 * Storage units (`storageReadUnits`, `storageWriteUnits`) are deliberately not
 * taken as rows. They are 4 KB units of the key-value backend, priced
 * differently. Billing them as `doRowsRead` / `doRowsWritten` would misstate the
 * bill, so a dataset that only has those is reported as unavailable, with the
 * fields it does have.
 * @throws {UsageUnavailableError} when the schema offers no dataset to meter.
 * @throws {CloudflareTokenError} when the token is refused.
 */
export const probeDurableObjectsDataset = async (access: CloudflareAccountAccess, now = Date.now()): Promise<DurableObjectsDataset> =>
    probeDataset(access, DURABLE_OBJECTS_ROWS, now);

/** One row of a probed dataset: its sums and dimensions, by the names the probe found. */
export interface ProbedGroup {
    dimensions?: Record<string, string | undefined>;
    sum?: Record<string, number | undefined>;
}

/**
 * The groups of a probed dataset in a closed window (`[sinceMs, untilMs)`),
 * with its sums and its attribution (and dispatch-namespace) dimension.
 * @throws {Error} when the result reaches {@link STORAGE_QUERY_LIMIT} rows and may be truncated.
 */
export const readProbedGroups = async (
    access: CloudflareAccountAccess,
    dataset: ProbedDataset,
    window: UsageWindow,
    options: { label: string; operation: string },
): Promise<ProbedGroup[]> => {
    const filter =
        dataset.filter === "hour"
            ? hourFilter(window, "datetimeHour_geq", "datetimeHour_leq")
            : `datetime_geq: ${JSON.stringify(graphqlTime(window.sinceMs))}, datetime_leq: ${JSON.stringify(graphqlTime(window.untilMs - 1000))}`;
    const dimensions = [dataset.by, ...(dataset.namespace === undefined ? [] : [dataset.namespace])].join(" ");
    const data = await cloudflareGraphql<{ viewer?: { accounts?: { rows?: ProbedGroup[] }[] } }>(
        access,
        `query ${options.operation}($accountTag: string!) { viewer { accounts(filter: { accountTag: $accountTag }) { rows: ${dataset.field}(limit: ${String(STORAGE_QUERY_LIMIT)}, filter: { ${filter} }) { sum { ${dataset.sums.join(" ")} } dimensions { ${dimensions} } } } } }`,
        { accountTag: access.accountId },
    );
    const groups = data.viewer?.accounts?.[0]?.rows ?? [];

    if (groups.length >= STORAGE_QUERY_LIMIT) {
        throw new Error(`${options.label} analytics hit the ${String(STORAGE_QUERY_LIMIT)}-row limit; refusing a truncated count`);
    }

    return groups;
};

/** The key of usage no tenant can be named for. It matches no `resourceRef`, so the rollback counts it as unattributed. */
const unattributed = (what: string): string => `unattributed:${what}`;

/**
 * Whether a namespace holds the tenants this reader meters: those of
 * `dispatchNamespace` on `cloudflare-wfp`, and on a connected account (no
 * dispatch namespace given) the plain Workers outside any dispatch namespace.
 */
const isTenantNamespace = (namespace: DurableObjectNamespaceRef, dispatchNamespace: string | undefined): boolean =>
    namespace.dispatchNamespace === dispatchNamespace;

/**
 * The tenant a dataset row belongs to, by the namespace list — never by its
 * name alone. `undefined` drops the row: it is a namespace outside this
 * reader's tenants (the platform's own Workers, another environment's dispatch
 * namespace in the same account), which no tenant here may be billed for.
 * Usage the list cannot place is keyed {@link unattributed}, so it is counted
 * and shown rather than billed to whoever has the same name:
 *
 * - a namespace id the list does not have, or one without a script;
 * - a script name the list does not have;
 * - a script name both a tenant namespace and another one carry (a staging and
 *   a production Worker named alike), since the row cannot be split between them.
 */
const tenantOf = (
    group: ProbedGroup,
    by: string,
    namespaces: ReadonlyArray<DurableObjectNamespaceRef>,
    dispatchNamespace: string | undefined,
): string | undefined => {
    if (by === "namespaceId") {
        const id = group.dimensions?.namespaceId;

        if (id === undefined || id === "") {
            return undefined;
        }

        const namespace = namespaces.find((candidate) => candidate.id === id);

        if (namespace === undefined) {
            return unattributed(`namespace:${id}`);
        }

        if (!isTenantNamespace(namespace, dispatchNamespace)) {
            return undefined;
        }

        return namespace.script ?? unattributed(`namespace:${id}`);
    }

    const script = group.dimensions?.scriptName;

    if (script === undefined || script === "") {
        return undefined;
    }

    const owners = namespaces.filter((namespace) => namespace.script === script);
    const tenant = owners.some((namespace) => isTenantNamespace(namespace, dispatchNamespace));
    const other = owners.some((namespace) => !isTenantNamespace(namespace, dispatchNamespace));

    if (tenant) {
        return other ? unattributed(`ambiguous-script:${script}`) : script;
    }

    return other ? undefined : unattributed(`script:${script}`);
};

/**
 * A Durable Objects dataset's usage per Worker script in a closed, hour-aligned
 * window (`[sinceMs, untilMs)`), each group turned into meters by `toUsage`.
 * Every row is placed through the namespace list ({@link tenantOf}), whichever
 * dimension the dataset has: only namespaces of this reader's tenants
 * (`dispatchNamespace` on `cloudflare-wfp`; outside any dispatch namespace on a
 * connected account) are attributed. The platform's own Workers and another
 * environment's are dropped, and what the list cannot place is keyed
 * `unattributed:…`, which the rollback counts and the sweep reports.
 */
export const readDurableObjectsByScript = async (
    access: CloudflareAccountAccess,
    window: UsageWindow,
    input: {
        dataset: ProbedDataset<string, "namespaceId" | "scriptName">;
        operation: string;
        toUsage: (sum: Record<string, number | undefined>) => PeriodUsage;
    },
    options: { dispatchNamespace?: string } = {},
): Promise<Map<string, PeriodUsage>> => {
    const [groups, namespaces] = await Promise.all([
        readProbedGroups(access, input.dataset, window, { label: "Durable Objects", operation: input.operation }),
        listDurableObjectNamespaces(access),
    ]);
    const byScript = new Map<string, PeriodUsage>();

    for (const group of groups) {
        const script = tenantOf(group, input.dataset.by, namespaces, options.dispatchNamespace);

        if (script !== undefined) {
            addUsage(byScript, script, input.toUsage(group.sum ?? {}));
        }
    }

    return byScript;
};

/**
 * Durable Object rows read and written per Worker script in a closed,
 * hour-aligned window, through the dataset the probe found
 * ({@link readDurableObjectsByScript} places each row).
 * @throws {UsageUnavailableError} when no dataset can be metered.
 * @throws {CloudflareTokenError} when the token lacks Account Analytics Read.
 */
export const readDurableObjectUsageByScript = async (
    access: CloudflareAccountAccess,
    window: UsageWindow,
    options: { dispatchNamespace?: string } = {},
): Promise<Map<string, PeriodUsage>> =>
    readDurableObjectsByScript(
        access,
        window,
        {
            dataset: await probeDurableObjectsDataset(access),
            operation: "LunoraDurableObjectRows",
            toUsage: (sum) => {
                return { doRowsRead: count(sum["rowsRead"]), doRowsWritten: count(sum["rowsWritten"]) };
            },
        },
        options,
    );

/**
 * Run one read of a usage source, reporting a refused token, or a query
 * Cloudflare rejects, as the source being unavailable. Neither changes by
 * retrying — a token does not gain a permission, a dataset does not gain a
 * field — so the sweep shows it (`UsageUnavailableError`) instead of logging a
 * failure every hour. Every other error passes through and is retried. The
 * checkpoint holds either way, so nothing is lost while it is shown.
 */
export const unavailableOnRefusal = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
        return await read();
    } catch (error) {
        if (error instanceof CloudflareTokenError || error instanceof CloudflareGraphqlQueryError) {
            throw new UsageUnavailableError(error.message);
        }

        throw error;
    }
};
