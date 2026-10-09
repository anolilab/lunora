/* eslint-disable no-secrets/no-secrets -- GraphQL dataset, field and operation names read as entropy; none is a credential */

/**
 * Compute read back from a Cloudflare account: Workers CPU time, and Durable
 * Object requests and duration, per tenant. These are the meters the rate card
 * prices (`cpuMs`, `doRequests`, `doDurationGbS`) that request and row counts
 * do not see: a Worker burning CPU on every request, a Durable Object woken a
 * million times, or one held awake for hours.
 *
 * Like the storage readers (`./storage-usage`), they read Cloudflare's GraphQL
 * datasets in closed, hour-aligned windows, and no field name is hard-coded.
 * Each meter has its own introspection probe ({@link probeDataset}), cached per
 * account, and a field is taken only where its unit is known:
 *
 * - **CPU time** — a `workersInvocations*` dataset with a `scriptName`
 *   dimension and a `cpuTimeUs` sum (microseconds, by its name), or a
 *   `cpuTime` sum whose schema description says microseconds. A CPU sum in any
 *   other unit is unavailable, never read as milliseconds by guess.
 * - **Durable Object requests** — a `durableObjects*` dataset with a
 *   `requests` sum (a count, so no unit to check).
 * - **Durable Object duration** — a `durableObjects*` dataset with a
 *   `duration` sum whose description states GB-seconds, the unit the rate card
 *   prices. Active or wall time in microseconds is NOT converted at an assumed
 *   memory size: the conversion is Cloudflare's to state, not ours.
 *
 * **Which tenants.** Durable Object rows are placed through the namespace list,
 * exactly as the row reader does. CPU rows are placed by script name, and on
 * `cloudflare-wfp` only rows of this environment's dispatch namespace count: the
 * cell account also holds the platform's own Workers and, when staging and
 * production share it, the other environment's tenants. So the CPU dataset must
 * have a dispatch-namespace dimension there, or CPU is unavailable on the cell
 * — never billed to whichever tenant shares a name. On a connected account the
 * tenants are plain Workers, so rows of any dispatch namespace are dropped when
 * the dimension exists.
 *
 * **What CPU misses on `cloudflare-wfp`.** Cloudflare bills a dispatch chain
 * (dispatcher → user Worker → outbound Worker) as one request with the CPU of
 * all three. Only the user Worker's CPU is attributable to a tenant; the
 * dispatcher's and outbound Worker's run outside the dispatch namespace and are
 * not metered. The `cpuMs` meter is therefore an under-count of the chain —
 * the fail-safe direction for a bill.
 */
import type { PeriodUsage } from "../billing/spend";
import { UsageUnavailableError } from "../metering/unavailable";
import type { UsageWindow } from "../targets/driver";
import type { CloudflareAccountAccess } from "./fetch";
import type { DatasetSpec, ProbedDataset, ProbedGroup } from "./storage-usage";
import { listAll, PROBE_TTL_MS, probeDataset, readDurableObjectsByScript, readProbedGroups } from "./storage-usage";

/** A positive, finite number; anything else is nothing. */
const positive = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The CPU-time dataset: `cpuTimeUs` (µs by name), else a `cpuTime` the schema says is in µs. */
export const WORKERS_CPU: DatasetSpec<"cpuTime" | "cpuTimeUs", "scriptName"> = {
    by: ["scriptName"],
    key: "workers:cpu",
    label: "Workers",
    namespaceDimension: { name: "dispatchNamespaceName", pattern: /^dispatchNamespace/u },
    preferred: ["workersInvocationsAdaptive"],
    prefix: "workersInvocations",
    requirement: "CPU time in microseconds (cpuTimeUs, or a cpuTime described in microseconds) with a scriptName dimension",
    sums: [{ name: "cpuTimeUs" }, { name: "cpuTime", unit: "microseconds" }],
};

/** The Durable Objects requests dataset. */
export const DURABLE_OBJECTS_REQUESTS: DatasetSpec<"requests", "namespaceId" | "scriptName"> = {
    by: ["namespaceId", "scriptName"],
    key: "durableObjects:requests",
    label: "Durable Objects",
    preferred: ["durableObjectsInvocationsAdaptiveGroups"],
    prefix: "durableObjects",
    requirement: "requests with a scriptName or namespaceId dimension",
    sums: [{ name: "requests" }],
};

/** The Durable Objects duration dataset: a `duration` the schema says is in GB-seconds. */
export const DURABLE_OBJECTS_DURATION: DatasetSpec<"duration", "namespaceId" | "scriptName"> = {
    by: ["namespaceId", "scriptName"],
    key: "durableObjects:duration",
    label: "Durable Objects",
    preferred: ["durableObjectsPeriodicGroups"],
    prefix: "durableObjects",
    requirement: "duration in GB-seconds with a scriptName or namespaceId dimension",
    sums: [{ name: "duration", unit: "gbSeconds" }],
};

/** A dispatch namespace as the account's listing reports it. */
export interface DispatchNamespaceRef {
    id?: string;
    name: string;
}

/** The dispatch-namespace listing per account, with when it was read; trusted for {@link PROBE_TTL_MS}, like a probe. */
const dispatchNamespaceListings = new Map<string, { at: number; namespaces: DispatchNamespaceRef[] }>();

/** Forget every dispatch-namespace listing — for tests, which each describe their own account. */
export const resetDispatchNamespaces = (): void => {
    dispatchNamespaceListings.clear();
};

/**
 * Every dispatch namespace of the account (`GET /accounts/{id}/workers/dispatch/namespaces`),
 * read once per {@link PROBE_TTL_MS}. A listing that cannot be read is not
 * remembered and answers nothing: rows are then matched by name alone, and a
 * dimension that carries ids shows as unavailable ({@link readWorkersCpuByScript}).
 */
export const listDispatchNamespaces = async (access: CloudflareAccountAccess, now = Date.now()): Promise<DispatchNamespaceRef[]> => {
    const known = dispatchNamespaceListings.get(access.accountId);

    if (known !== undefined && now - known.at < PROBE_TTL_MS) {
        return known.namespaces;
    }

    try {
        const rows = await listAll<{ namespace_id?: unknown; namespace_name?: unknown }>(access, `/accounts/${access.accountId}/workers/dispatch/namespaces`);
        const namespaces = rows.flatMap((row) =>
            typeof row.namespace_name === "string"
                ? [{ name: row.namespace_name, ...(typeof row.namespace_id === "string" ? { id: row.namespace_id } : {}) }]
                : [],
        );

        dispatchNamespaceListings.set(access.accountId, { at: now, namespaces });

        return namespaces;
    } catch {
        return [];
    }
};

/** Namespace values shown in an unavailable reason, at most. */
const SHOWN_VALUES = 3;

/**
 * The namespace values a CPU row may carry: `ours` (this environment's name and
 * id, or `""` — no namespace — on a connected account), and on the cell `known`
 * (every namespace the account lists, and none), outside which a value is unplaceable.
 */
const namespaceValues = (
    listed: ReadonlyArray<DispatchNamespaceRef>,
    dispatchNamespace: string | undefined,
): { known: Set<string> | undefined; ours: Set<string> } => {
    // A connected account's own dispatch namespaces are its business: dropped, never unplaceable.
    if (dispatchNamespace === undefined) {
        return { known: undefined, ours: new Set([""]) };
    }

    const own = listed.find((entry) => entry.name === dispatchNamespace)?.id;

    return {
        known: new Set(["", ...listed.flatMap((entry) => [entry.name, ...(entry.id === undefined ? [] : [entry.id])])]),
        ours: new Set([dispatchNamespace, ...(own === undefined ? [] : [own])]),
    };
};

/** CPU per script of the rows of our namespace, how many rows were ours, and the values no listed namespace has. */
const placeCpuRows = (
    groups: ReadonlyArray<ProbedGroup>,
    dataset: ProbedDataset<"cpuTime" | "cpuTimeUs", "scriptName">,
    values: { known: ReadonlySet<string> | undefined; ours: ReadonlySet<string> },
): { byScript: Map<string, PeriodUsage>; matched: number; unknown: Set<string> } => {
    // The probe found at least one, and both candidates are microseconds: one by its name, the other by its description.
    const [field] = dataset.sums;
    const byScript = new Map<string, PeriodUsage>();
    const unknown = new Set<string>();
    let matched = 0;

    for (const group of groups) {
        const rowNamespace = dataset.namespace === undefined ? "" : (group.dimensions?.[dataset.namespace] ?? "");

        if (!values.ours.has(rowNamespace)) {
            if (values.known !== undefined && !values.known.has(rowNamespace)) {
                unknown.add(rowNamespace);
            }

            continue;
        }

        matched += 1;

        const script = group.dimensions?.[dataset.by];
        const cpuMs = positive(group.sum?.[field]) / 1000;

        if (script && cpuMs > 0) {
            byScript.set(script, { cpuMs: (byScript.get(script)?.cpuMs ?? 0) + cpuMs });
        }
    }

    return { byScript, matched, unknown };
};

/**
 * Workers CPU time per script, in milliseconds, in a closed, hour-aligned window
 * (`[sinceMs, untilMs)`).
 *
 * - With `dispatchNamespace` (`cloudflare-wfp`): only rows of that dispatch
 *   namespace, by its name or its id (from the account's listing), whichever
 *   the dimension carries. A dataset without a dispatch-namespace dimension
 *   cannot tell them apart, so it is unavailable. So is a read whose rows carry
 *   namespace values that match neither this namespace nor any other the
 *   account lists, while none matches ours: the dimension is in a form this
 *   reader does not know, and dropping every row would read as zero and
 *   advance the checkpoint past usage that happened.
 * - Without (a connected account): rows of any dispatch namespace are dropped
 *   when the dataset says which they are.
 * @throws {UsageUnavailableError} when no dataset reports CPU time in a known unit, or the namespace cannot be told.
 * @throws {CloudflareTokenError} when the token lacks Account Analytics Read.
 */
export const readWorkersCpuByScript = async (
    access: CloudflareAccountAccess,
    window: UsageWindow,
    options: { dispatchNamespace?: string } = {},
): Promise<Map<string, PeriodUsage>> => {
    const dataset = await probeDataset(access, WORKERS_CPU);
    const { namespace } = dataset;
    const { dispatchNamespace } = options;

    if (dispatchNamespace !== undefined && namespace === undefined) {
        throw new UsageUnavailableError(
            `${dataset.field} has no dispatch-namespace dimension, so this environment's tenants cannot be told from other Workers in the account`,
        );
    }

    const listed = dispatchNamespace === undefined ? [] : await listDispatchNamespaces(access);
    const groups = await readProbedGroups(access, dataset, window, { label: "Workers", operation: "LunoraWorkerCpu" });
    const { byScript, matched, unknown } = placeCpuRows(groups, dataset, namespaceValues(listed, dispatchNamespace));

    if (matched === 0 && unknown.size > 0) {
        throw new UsageUnavailableError(
            `no ${dataset.field} row's ${String(namespace)} matches the dispatch namespace ${JSON.stringify(dispatchNamespace)} or its id; seen: ${[...unknown]
                .slice(0, SHOWN_VALUES)
                .map((value) => JSON.stringify(value.slice(0, 64)))
                .join(", ")}`,
        );
    }

    return byScript;
};

/**
 * Durable Object requests per Worker script in a closed, hour-aligned window,
 * placed through the namespace list like the row reader.
 * @throws {UsageUnavailableError} when no dataset reports Durable Object requests.
 * @throws {CloudflareTokenError} when the token lacks Account Analytics Read.
 */
export const readDurableObjectRequestsByScript = async (
    access: CloudflareAccountAccess,
    window: UsageWindow,
    options: { dispatchNamespace?: string } = {},
): Promise<Map<string, PeriodUsage>> =>
    readDurableObjectsByScript(
        access,
        window,
        {
            dataset: await probeDataset(access, DURABLE_OBJECTS_REQUESTS),
            operation: "LunoraDurableObjectRequests",
            toUsage: (sum) => {
                return { doRequests: positive(sum.requests) };
            },
        },
        options,
    );

/**
 * Durable Object duration per Worker script, in GB-seconds, in a closed,
 * hour-aligned window, placed through the namespace list like the row reader.
 * @throws {UsageUnavailableError} when no dataset reports duration in GB-seconds.
 * @throws {CloudflareTokenError} when the token lacks Account Analytics Read.
 */
export const readDurableObjectDurationByScript = async (
    access: CloudflareAccountAccess,
    window: UsageWindow,
    options: { dispatchNamespace?: string } = {},
): Promise<Map<string, PeriodUsage>> =>
    readDurableObjectsByScript(
        access,
        window,
        {
            dataset: await probeDataset(access, DURABLE_OBJECTS_DURATION),
            operation: "LunoraDurableObjectDuration",
            toUsage: (sum) => {
                return { doDurationGbS: positive(sum.duration) };
            },
        },
        options,
    );
