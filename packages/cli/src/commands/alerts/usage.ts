/**
 * Last month's usage per metered product, from the GraphQL Analytics API.
 *
 * Several of the field names below have no published reference, so no field is
 * queried on trust: the schema is introspected first, along the path
 * `viewer → accounts → <dataset> → sum`, and a metric whose field the schema
 * does not expose is reported unavailable instead of being sent as a guess.
 * Each metric is its own query, so one rejected field costs that metric alone.
 */
import type { CloudflareClient } from "./api";
import { CloudflareApiError } from "./api";

type MetricId = "d1-rows-read" | "d1-rows-written" | "do-duration" | "do-requests" | "do-rows-read" | "do-rows-written" | "workers-cpu" | "workers-requests";

/** `count` is a plain number of events; `microseconds` is a time total; `unknown` is a field whose unit is unpublished. */
type MetricUnit = "count" | "microseconds" | "unknown";

/** The calendar month the usage covers. */
interface UsagePeriod {
    /** `YYYY-MM-DD`, the last day of the month (for display). */
    endDate: string;
    /** `YYYY-MM-DD`, the first day of the next month — the exclusive upper bound every filter uses. */
    nextStartDate: string;
    /** `YYYY-MM-DD`, the first day of the month. */
    startDate: string;
}

type FilterStyle = "date" | "datetime" | "datetime-hour";

interface MetricDefinition {
    /** Field names in preference order, each with its unit; the first the schema exposes is used. */
    candidates: ReadonlyArray<{ field: string; unit: MetricUnit }>;
    dataset: string;
    filter: FilterStyle;
    id: MetricId;
    label: string;
}

/* eslint-disable no-secrets/no-secrets -- GraphQL Analytics dataset and field names, not credentials */

/**
 * The datasets queried, and the provenance of each name: `workersInvocationsAdaptive.sum.requests`
 * and `datetime_geq` — Cloudflare's "Querying Workers metrics" tutorial;
 * `durableObjectsInvocationsAdaptiveGroups.sum.requests` — the Durable Objects GraphQL page;
 * `d1AnalyticsAdaptiveGroups.sum.rowsRead/rowsWritten` and `datetimeHour_geq` — the query wrangler
 * itself sends. Unpublished: the fields `cpuTimeUs`, `activeTime` and the periodic dataset's
 * `rowsRead`/`rowsWritten` (introspection gates them), and the `date_geq` filter and the exclusive
 * `_lt` upper bounds (not introspected — a rejected filter makes that metric unavailable).
 */
const WORKERS_DATASET = "workersInvocationsAdaptive";
const DO_INVOCATIONS_DATASET = "durableObjectsInvocationsAdaptiveGroups";
const DO_PERIODIC_DATASET = "durableObjectsPeriodicGroups";
const D1_DATASET = "d1AnalyticsAdaptiveGroups";
/* eslint-enable no-secrets/no-secrets */

/** The metrics `lunora alerts` reports. */
const METRICS: ReadonlyArray<MetricDefinition> = [
    {
        candidates: [{ field: "requests", unit: "count" }],
        dataset: WORKERS_DATASET,
        filter: "datetime",
        id: "workers-requests",
        label: "Workers requests",
    },
    {
        candidates: [{ field: "cpuTimeUs", unit: "microseconds" }],
        dataset: WORKERS_DATASET,
        filter: "datetime",
        id: "workers-cpu",
        label: "Workers CPU time",
    },
    {
        candidates: [{ field: "requests", unit: "count" }],
        dataset: DO_INVOCATIONS_DATASET,
        filter: "date",
        id: "do-requests",
        label: "Durable Objects requests",
    },
    {
        candidates: [{ field: "activeTime", unit: "unknown" }],
        dataset: DO_PERIODIC_DATASET,
        filter: "date",
        id: "do-duration",
        label: "Durable Objects duration",
    },
    {
        candidates: [{ field: "rowsRead", unit: "count" }],
        dataset: DO_PERIODIC_DATASET,
        filter: "date",
        id: "do-rows-read",
        label: "Durable Objects rows read",
    },
    {
        candidates: [{ field: "rowsWritten", unit: "count" }],
        dataset: DO_PERIODIC_DATASET,
        filter: "date",
        id: "do-rows-written",
        label: "Durable Objects rows written",
    },
    {
        candidates: [{ field: "rowsRead", unit: "count" }],
        dataset: D1_DATASET,
        filter: "datetime-hour",
        id: "d1-rows-read",
        label: "D1 rows read",
    },
    {
        candidates: [{ field: "rowsWritten", unit: "count" }],
        dataset: D1_DATASET,
        filter: "datetime-hour",
        id: "d1-rows-written",
        label: "D1 rows written",
    },
];

/** One metric's reading: a number, or why there is none. */
type MetricUsage =
    | { field: string; id: MetricId; label: string; status: "ok"; unit: MetricUnit; value: number }
    | { id: MetricId; label: string; reason: string; status: "unavailable" };

const pad = (value: number): string => String(value).padStart(2, "0");

/** The calendar month before `now`, in UTC. */
const previousMonth = (now: Date): UsagePeriod => {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const day = (date: Date): string => `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

    return { endDate: day(end), nextStartDate: day(next), startDate: day(start) };
};

/**
 * The dataset filter for `period`, as a GraphQL input-object literal: from the
 * month's first instant, up to but excluding the next month's first.
 */
const filterLiteral = (style: FilterStyle, period: UsagePeriod): string => {
    const from = JSON.stringify(`${period.startDate}T00:00:00Z`);
    const until = JSON.stringify(`${period.nextStartDate}T00:00:00Z`);

    switch (style) {
        case "date": {
            return `{ date_geq: ${JSON.stringify(period.startDate)}, date_lt: ${JSON.stringify(period.nextStartDate)} }`;
        }
        case "datetime": {
            return `{ datetime_geq: ${from}, datetime_lt: ${until} }`;
        }
        default: {
            return `{ AND: [{ datetimeHour_geq: ${from}, datetimeHour_lt: ${until} }] }`;
        }
    }
};

/** Introspect one type's fields; the name is inlined so the query declares no variable type. */
const typeFieldsQuery = (typeName: string): string =>
    `query LunoraTypeFields { __type(name: ${JSON.stringify(typeName)}) { fields { name type { name ofType { name ofType { name ofType { name } } } } } } }`;

interface IntrospectedType {
    name?: string | null;
    ofType?: IntrospectedType | null;
}

/** Strip list / non-null wrappers down to the named type. */
const namedType = (type: IntrospectedType | null | undefined): string | undefined => {
    let current = type;

    while (current !== null && current !== undefined) {
        if (typeof current.name === "string" && current.name.length > 0) {
            return current.name;
        }

        current = current.ofType;
    }

    return undefined;
};

/** Field name → named type, per type name; one introspection call per type, shared by every metric. */
const createSchemaReader = (client: CloudflareClient): ((typeName: string) => Promise<Map<string, string | undefined>>) => {
    const cache = new Map<string, Promise<Map<string, string | undefined>>>();

    return async (typeName) => {
        const cached = cache.get(typeName);

        if (cached !== undefined) {
            return cached;
        }

        const pending = client.graphql(`Reading the analytics schema (${typeName})`, typeFieldsQuery(typeName)).then((outcome) => {
            if (outcome.errors.length > 0) {
                throw new CloudflareApiError(`Reading the analytics schema failed: ${outcome.errors.join("; ")}.`, "rejected");
            }

            // `__type` is GraphQL's introspection field, read by key because of its spec-mandated underscores.
            const data = outcome.data as Record<string, { fields?: { name: string; type: IntrospectedType }[] | null } | null> | undefined;
            const fields = data?.["__type"]?.fields ?? [];

            return new Map(fields.map((field) => [field.name, namedType(field.type)]));
        });

        cache.set(typeName, pending);

        return pending;
    };
};

/** The fields of the type at the end of `path`, walking one field at a time from `typeName`. */
const fieldsAt = async (
    readType: (typeName: string) => Promise<Map<string, string | undefined>>,
    typeName: string,
    path: ReadonlyArray<string>,
): Promise<Map<string, string | undefined>> => {
    const fields = await readType(typeName);
    const [step, ...rest] = path;

    if (step === undefined) {
        return fields;
    }

    const next = fields.get(step);

    if (next === undefined) {
        throw new CloudflareApiError(`the analytics schema has no \`${step}\` on \`${typeName}\``, "rejected");
    }

    return fieldsAt(readType, next, rest);
};

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Read one metric's total, or say why it could not be read. */
const readMetric = async (
    client: CloudflareClient,
    readType: (typeName: string) => Promise<Map<string, string | undefined>>,
    rootType: string,
    metric: MetricDefinition,
    period: UsagePeriod,
): Promise<MetricUsage> => {
    const { id, label } = metric;

    try {
        const sumFields = await fieldsAt(readType, rootType, ["viewer", "accounts", metric.dataset, "sum"]);
        const chosen = metric.candidates.find((candidate) => sumFields.has(candidate.field));

        if (chosen === undefined) {
            const tried = metric.candidates.map((candidate) => `\`${candidate.field}\``).join(", ");

            return { id, label, reason: `\`${metric.dataset}.sum\` exposes no ${tried} field`, status: "unavailable" };
        }

        // No dimensions: one aggregate group for the whole month, so `limit: 1` cannot truncate.
        const query =
            `query LunoraUsage($accountTag: string) { viewer { accounts(filter: { accountTag: $accountTag }) { ` +
            `${metric.dataset}(limit: 1, filter: ${filterLiteral(metric.filter, period)}) { sum { ${chosen.field} } } } } }`;
        const outcome = await client.graphql(`Reading ${label}`, query, { accountTag: client.accountId });

        if (outcome.errors.length > 0) {
            return { id, label, reason: outcome.errors.join("; "), status: "unavailable" };
        }

        const groups = (outcome.data as { viewer?: { accounts?: Record<string, unknown>[] } } | undefined)?.viewer?.accounts?.[0]?.[metric.dataset];
        const first = Array.isArray(groups) ? (groups[0] as { sum?: Record<string, unknown> } | undefined) : undefined;
        // An empty list is a month with no usage of the product at all.
        const raw = first === undefined ? 0 : first.sum?.[chosen.field];

        if (typeof raw !== "number" || !Number.isFinite(raw)) {
            return { id, label, reason: `the response carried no number for \`${chosen.field}\``, status: "unavailable" };
        }

        return { field: `${metric.dataset}.sum.${chosen.field}`, id, label, status: "ok", unit: chosen.unit, value: raw };
    } catch (error) {
        return { id, label, reason: reasonOf(error), status: "unavailable" };
    }
};

/**
 * Read every metric for `period`. Never throws for a per-metric problem; an HTTP
 * auth or permission failure on the first call is rethrown, because every
 * metric would fail the same way and the caller can name the missing scope once.
 */
const readUsage = async (client: CloudflareClient, period: UsagePeriod): Promise<MetricUsage[]> => {
    const root = await client.graphql("Reading the analytics schema", "query LunoraQueryRoot { __schema { queryType { name } } }");
    const rootType = (root.data as Record<string, { queryType?: { name?: string } } | undefined> | undefined)?.["__schema"]?.queryType?.name;

    if (root.errors.length > 0 || rootType === undefined) {
        const reason = root.errors.length > 0 ? root.errors.join("; ") : "the schema root could not be read";

        return METRICS.map(({ id, label }) => {
            return { id, label, reason, status: "unavailable" };
        });
    }

    const readType = createSchemaReader(client);

    return Promise.all(METRICS.map(async (metric) => readMetric(client, readType, rootType, metric, period)));
};

export type { MetricDefinition, MetricId, MetricUnit, MetricUsage, UsagePeriod };
export { METRICS, previousMonth, readUsage };
