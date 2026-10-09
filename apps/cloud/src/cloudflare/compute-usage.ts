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
import type { DatasetSpec } from "./storage-usage";
import { probeDataset, readDurableObjectsByScript, readProbedGroups } from "./storage-usage";

/** A positive, finite number; anything else is nothing. */
const positive = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** A description that states microseconds. */
const MICROSECONDS = /microsecond/iu;

/** A description that states gigabyte-seconds. */
const GB_SECONDS = /\bGB\W{0,3}s(?:ec|\b)|gigabyte\W?second/iu;

/** The CPU-time dataset: `cpuTimeUs` (µs by name), else a `cpuTime` the schema says is in µs. */
export const WORKERS_CPU: DatasetSpec<"cpuTime" | "cpuTimeUs", "scriptName"> = {
    by: ["scriptName"],
    key: "workers:cpu",
    label: "Workers",
    namespaceDimension: /^dispatchNamespace/u,
    preferred: ["workersInvocationsAdaptive"],
    prefix: "workersInvocations",
    requirement: "CPU time in microseconds (cpuTimeUs, or a cpuTime described in microseconds) with a scriptName dimension",
    sums: [{ name: "cpuTimeUs" }, { name: "cpuTime", unit: MICROSECONDS }],
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
    sums: [{ name: "duration", unit: GB_SECONDS }],
};

/**
 * Workers CPU time per script, in milliseconds, in a closed, hour-aligned window
 * (`[sinceMs, untilMs)`).
 *
 * - With `dispatchNamespace` (`cloudflare-wfp`): only rows of that dispatch
 *   namespace. A dataset without a dispatch-namespace dimension cannot tell
 *   them apart, so it is unavailable.
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

    if (options.dispatchNamespace !== undefined && namespace === undefined) {
        throw new UsageUnavailableError(
            `${dataset.field} has no dispatch-namespace dimension, so this environment's tenants cannot be told from other Workers in the account`,
        );
    }

    // The probe found at least one, and both candidates are microseconds: one by its name, the other by its description.
    const [field] = dataset.sums;
    const groups = await readProbedGroups(access, dataset, window, { label: "Workers", operation: "LunoraWorkerCpu" });
    const byScript = new Map<string, PeriodUsage>();

    for (const group of groups) {
        const script = group.dimensions?.[dataset.by];
        const rowNamespace = namespace === undefined ? "" : (group.dimensions?.[namespace] ?? "");
        const cpuMs = positive(group.sum?.[field]) / 1000;

        if (!script || rowNamespace !== (options.dispatchNamespace ?? "") || cpuMs === 0) {
            continue;
        }

        byScript.set(script, { cpuMs: (byScript.get(script)?.cpuMs ?? 0) + cpuMs });
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
