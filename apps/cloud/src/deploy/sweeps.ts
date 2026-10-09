/**
 * Control-plane sweep port-builders (§2.3 / §4). The scheduled Worker runs two
 * data-plane sweeps — tenant teardown and the usage rollback —
 * each expressed as a pure function over injected ports (`runTeardownSweep`,
 * `runUsageRollback`). These builders wire those ports to the control-plane D1,
 * so the row→target mapping, the `teardownAt` marker, the ledger insert, and the
 * per-scope checkpoint are testable against a fake store (server.ts just supplies
 * the real ctx-db and the target drivers).
 *
 * Every row is read with its `target` (absent on rows that predate it, which
 * are `cloudflare-wfp`), so each sweep acts through the right driver.
 */
import type { SpendAccrual } from "../billing/spend";
import { accruedSpend } from "../billing/spend";
import { isBilledReadback } from "../billing/usage";
import type { ControlPlaneStore } from "../d1-store";
import type { UsageAttribution, UsageRollbackPorts } from "../metering/rollback";
import { runUsageRollback } from "../metering/rollback";
import { UsageUnavailableError } from "../metering/unavailable";
import type { TargetId } from "../provision-contract";
import { storedTarget } from "../provision-contract";
import type { ControlPlaneDatabase } from "../store";
import { drainTable } from "../store";
import type { ProgressLine, TargetDriver, UsageFamily, UsageReadback, UsageSource } from "../targets/driver";
import { USAGE_FAMILIES } from "../targets/driver";
import type { Placement, RowReader } from "../targets/placement";
import { placementOfDeployment } from "../targets/placement";
import type { TeardownPorts, TeardownTarget } from "./teardown";

interface TeardownRow {
    _id: string;
    alias?: string;
    createdAt?: number;
    kind: string;
    placementRef?: null | string;
    projectId: string;
    scriptName: string;
    status: string;
    target?: string;
    teardownAt?: number;
}

/**
 * Ports for {@link runTeardownSweep}: destroyed or failed deployments whose
 * stored release has not been reclaimed, each with the target it was deployed
 * to, and the `teardownAt` stamp. `deleteRelease` and `driverFor` are supplied by
 * the caller (the `RELEASES` bucket and the target registry).
 *
 * `destroy` places each alias off its deployment rows (`placementOfDeployment`)
 * and destroys it through that placement's driver. An alias whose host is gone
 * or revoked is beyond reach for good: it is logged and its alias released. One
 * whose host cannot be named at all throws, which keeps the row pending and
 * the alias claimed.
 *
 * `destroyWorker` is true only when the alias has no deployment left that is not
 * `destroyed` — so the alias's tenant and D1/R2 are reclaimed on project/org
 * deletion or preview expiry, but never on a routine prune (which would delete
 * the live release's database). Reads the full deployments set once to evaluate
 * that, and elects one pending row per dead alias so the destroy job runs once.
 *
 * `canConverge` says which targets this control plane can tear down right now;
 * a row of any other target stays pending, untouched, until one can — exactly
 * what the whole sweep did before targets, when the provision box was unbound.
 */
export const teardownPorts = (
    database: ControlPlaneDatabase,
    ports: Pick<TeardownPorts, "deleteRelease"> & {
        driverFor: (placement: Placement) => TargetDriver;
        log: ProgressLine;
        /** Reads the host rows deployments name (`storeRowReader`). */
        read: RowReader;
    },
    now: number,
    canConverge: (target: TargetId) => boolean,
): TeardownPorts => {
    return {
        deleteRelease: ports.deleteRelease,
        destroy: async (target) => {
            const placed = await placementOfDeployment(target, ports.read);

            if ("unplaced" in placed) {
                if (!placed.settled) {
                    throw new Error(`alias "${target.alias}" ${placed.unplaced}`);
                }

                ports.log(`alias "${target.alias}": ${placed.unplaced}, releasing the alias`);

                return;
            }

            await ports.driverFor(placed.placement).destroy(target.alias, { onProgress: ports.log });
        },
        listPending: async () => {
            // Drained: teardown has to see every deployment, and a single page left
            // the tail of the fleet permanently un-torn-down — leaking the real
            // dispatch scripts, tenant D1 and R2 that this sweep exists to reclaim.
            const rows = await drainTable<TeardownRow>(database, "deployments");

            // Aliases that still have a deployment that is not destroyed.
            const aliveAliases = new Set<string>();

            // `!= null`, not `!== undefined`: `deployments` is `.global()`, so these rows
            // come from D1, which returns SQL NULL — never `undefined` — for an unset
            // optional column. The checks below all read optional columns, and all
            // invert if they test for `undefined`: the sweep silently selects nothing
            // (leaking every Worker, tenant D1 and R2 bucket forever), and
            // `destroyWorker` flips to `true` for an alias-less row, which is the one
            // case this function exists to prevent.
            for (const row of rows) {
                if (row.status !== "destroyed" && row.alias != null) {
                    aliveAliases.add(row.alias);
                }
            }

            // The host each alias was last converged on: its newest row that names
            // one. A project that moved leaves older rows naming the old one.
            const newest = new Map<string, { at: number; placementRef: string }>();

            for (const row of rows) {
                const alias = row.alias ?? row.scriptName;
                const at = row.createdAt ?? 0;
                const known = newest.get(alias);

                if (row.placementRef != null && (known === undefined || at >= known.at)) {
                    newest.set(alias, { at, placementRef: row.placementRef });
                }
            }

            const elected = new Set<string>();

            return (
                rows
                    .filter((row) => (row.status === "destroyed" || row.status === "failed") && row.teardownAt == null)
                    .map((row) => {
                        const alias = row.alias ?? row.scriptName;
                        const destroyWorker = row.status === "destroyed" && row.alias != null && !aliveAliases.has(alias) && !elected.has(alias);

                        if (destroyWorker) {
                            elected.add(alias);
                        }

                        const placementRef = newest.get(alias)?.placementRef;

                        return {
                            alias,
                            destroyWorker,
                            id: row._id,
                            ...(placementRef === undefined ? {} : { placementRef }),
                            projectId: row.projectId,
                            target: storedTarget(row.target),
                        };
                    })
                    // A row whose target is unknown, or cannot converge here, waits.
                    .filter((target): target is TeardownTarget => target.target !== undefined && canConverge(target.target))
            );
        },
        markTornDown: async (id) => {
            await database.patch(id, { teardownAt: now, updatedAt: now }, "deployments");
        },
        releaseAlias: async (alias, projectId) => {
            // Drop the torn-down project's claim on the alias so the label is free to
            // re-claim. Only its own: a claim of another project is that project's
            // reservation (`projects.create` claims before any deployment exists),
            // which an alias-wide delete would hand to whoever claims next.
            // Idempotent: no row (already released) is a no-op.
            const { page } = await database.findMany("aliasOwnership", { where: { alias, projectId } });

            for (const row of page as { _id: string }[]) {
                // eslint-disable-next-line no-await-in-loop -- at most one row per alias (by_alias is unique)
                await database.delete(row._id, "aliasOwnership");
            }

            // An emergency stop of the torn-down tenant holds nothing any more, and must not hold whoever claims the alias next.
            const { page: halts } = await database.findMany("halts", { where: { alias, projectId } });

            for (const row of halts as { _id: string }[]) {
                // eslint-disable-next-line no-await-in-loop -- at most one row per alias (by_alias is unique)
                await database.delete(row._id, "halts");
            }
        },
    };
};

interface AttributionRow {
    _id: string;
    organizationId: string;
    placementRef?: null | string;
    resourceRef?: string;
    scriptName: string;
    status: string;
    target?: string;
}

interface CheckpointRow {
    _id: string;
    readAtMs: number;
}

interface StatusRow {
    _id: string;
    failingSince?: null | number;
}

/**
 * The `usageCheckpoints.scopeKey` of one (scope, family). The `requests` family
 * keeps the bare scope its checkpoints were always stored under, so existing
 * checkpoints carry over unchanged. Every other family appends `#family`. A
 * cell name and a connected-account row id never contain `#`.
 */
export const usageScopeKey = (scope: string, family: UsageFamily): string => (family === "requests" ? scope : `${scope}#${family}`);

/**
 * What one run of one (scope, family) found, kept in `usageSourceStatus` for the
 * Usage tab and the operator. Each run writes the fields its outcome sets; a
 * `null` clears one.
 */
export type UsageSourceStatus =
    /** A read failed this time (a 5xx, a 429, a truncated result); retried next hour, shown once it persists. */
    | { kind: "failed"; message: string }
    /** The source read: what it could not attribute, and any span too old to read. */
    | { gap?: string; kind: "read"; unattributedQuantity: number }
    /** The source cannot read at all; the reason stays until it reads again. */
    | { kind: "unavailable"; message: string };

/** Insert `fields` as a new row of `table` for one (target, scope key), or patch the row `rowId` names. */
const upsertRow = async (
    database: ControlPlaneDatabase,
    table: string,
    rowId: string | undefined,
    fields: Record<string, unknown>,
    options: { now: number; scopeKey: string; target: TargetId },
): Promise<string> => {
    if (rowId !== undefined) {
        await database.patch(rowId, { ...fields, updatedAt: options.now }, table);

        return rowId;
    }

    // An insert leaves a cleared field unset rather than writing an explicit NULL.
    const set = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));

    return (await database.insert(table, { ...set, scopeKey: options.scopeKey, target: options.target, updatedAt: options.now })) as string;
};

/**
 * The checkpoint of one (target, scope key) and how to advance it. Reads only
 * `usageCheckpoints`: request billing never depends on the status table.
 */
const checkpointPorts = async (
    database: ControlPlaneDatabase,
    options: { now: number; scopeKey: string; target: TargetId },
): Promise<Pick<UsageRollbackPorts, "getCheckpoint" | "setCheckpoint">> => {
    const { page } = await database.findMany("usageCheckpoints", { where: { scopeKey: options.scopeKey, target: options.target } });
    const checkpoint = (page as CheckpointRow[]).at(0);
    // The row's id once it exists, so a second write in the same run patches it
    // rather than inserting a duplicate (a run writes one checkpoint per month part).
    let checkpointId = checkpoint?._id;

    return {
        getCheckpoint: () => Promise.resolve(checkpoint?.readAtMs),
        setCheckpoint: async (ms) => {
            checkpointId = await upsertRow(database, "usageCheckpoints", checkpointId, { readAtMs: ms }, options);
        },
    };
};

/**
 * Record what one run of a (target, scope key) found in `usageSourceStatus` —
 * its own table, read only here, so writing it can never create or move a
 * checkpoint, and a failing status table never stops billing.
 */
export const recordSourceStatus = async (
    database: ControlPlaneDatabase,
    status: UsageSourceStatus,
    options: { now: number; scopeKey: string; target: TargetId },
): Promise<void> => {
    const { page } = await database.findMany("usageSourceStatus", { where: { scopeKey: options.scopeKey, target: options.target } });
    const row = (page as StatusRow[]).at(0);
    let fields: Record<string, unknown>;

    if (status.kind === "read") {
        fields = {
            failingSince: null,
            lastError: null,
            unattributedQuantity: status.unattributedQuantity,
            unavailableReason: null,
            ...(status.gap === undefined ? {} : { gapNote: status.gap, gapRecordedAt: options.now }),
        };
    } else if (status.kind === "unavailable") {
        fields = { failingSince: null, lastError: null, unavailableReason: status.message };
    } else {
        // Since the FIRST failure in a row: how long the source has been stuck is what makes it worth showing.
        fields = { failingSince: row?.failingSince ?? options.now, lastError: status.message };
    }

    await upsertRow(database, "usageSourceStatus", row?._id, fields, options);
};

/**
 * Which deployment each `resourceRef` of `target` attributes its usage to,
 * from every deployment row. Every release of an alias shares its one tenant,
 * so a resource's usage is attributed to the live release when there is one.
 * Built once per target per sweep and shared by all of its scopes.
 */
export const usageAttributionOf = (deploymentRows: ReadonlyArray<AttributionRow>, target: TargetId): ReadonlyMap<string, UsageAttribution> => {
    const byResource = new Map<string, UsageAttribution>();

    for (const row of deploymentRows) {
        if (storedTarget(row.target) !== target) {
            continue;
        }

        // Rows that predate `resourceRef` are addressed by their script name.
        const resourceRef = row.resourceRef ?? row.scriptName;

        if (!byResource.has(resourceRef) || row.status === "live") {
            byResource.set(resourceRef, {
                deploymentId: row._id,
                organizationId: row.organizationId,
                ...(row.placementRef == null ? {} : { placementRef: row.placementRef }),
            });
        }
    }

    return byResource;
};

/** Fold one billable ledger row into its org's running spend, read-modify-write through the store. */
const accrueOrganizationSpend = async (
    database: ControlPlaneStore,
    organizationId: string,
    row: { kind: string; periodStart: number; quantity: number },
    now: number,
): Promise<void> => {
    const organization = (await database.get(organizationId, "organizations")) as null | SpendAccrual;
    const next = organization === null ? null : accruedSpend(organization, row, now);

    if (next !== null) {
        await database.patch(organizationId, next, "organizations");
    }
};

/**
 * Build the {@link runUsageRollback} ports against the control-plane D1 for one
 * (scope, family) of one `readback` target, over that target's attribution map
 * ({@link usageAttributionOf}). Reads the pair's checkpoint (`usageCheckpoints`)
 * up front, then returns ports that resolve a resource → org/deployment, append
 * one `platformUsage` row per meter, and advance the pair's checkpoint — never
 * another pair's, so two sources never skip each other's windows.
 */
export const usageRollbackPorts = async (
    database: ControlPlaneStore,
    source: UsageSource & { scope: string },
    options: { attribution: ReadonlyMap<string, UsageAttribution>; family: UsageFamily; now: number; target: TargetId },
): Promise<UsageRollbackPorts> => {
    return {
        ...(await checkpointPorts(database, { now: options.now, scopeKey: usageScopeKey(source.scope, options.family), target: options.target })),
        cadence: source.cadence,
        now: options.now,
        read: async (window) => source.read(source.scope, window),
        record: async ({ attribution, meter, periodStart, quantity, window }) => {
            // A tenant on a host its organization owns (its own Cloudflare account):
            // its usage is on the customer's bill. And a meter not yet verified
            // against a live account is alert-only (`UNVERIFIED_METERS`). Either
            // way the row is shown and never billed.
            const billable = isBilledReadback(options.target, meter);

            await database.insert("platformUsage", {
                ...(billable ? {} : { billable: false }),
                createdAt: options.now,
                deploymentId: attribution.deploymentId,
                kind: meter,
                organizationId: attribution.organizationId,
                periodStart,
                ...(attribution.placementRef === undefined ? {} : { placementRef: attribution.placementRef }),
                quantity,
                // When the usage happened, which the anomaly sweep scores by.
                windowEnd: window.untilMs,
                windowStart: window.sinceMs,
            });

            if (billable) {
                // The admission fast path's running spend (plan 365 W3). Best-effort
                // and after the ledger write: the hourly cap sweep rewrites it from the
                // ledger, so a lost accrual delays the fast path, never the cap. A row
                // of a past month never moves it (`accruedSpend`).
                await accrueOrganizationSpend(database, attribution.organizationId, { kind: meter, periodStart, quantity }, options.now).catch(() => undefined);
            }
        },
        resolveResource: (resourceRef) => options.attribution.get(resourceRef),
    };
};

/**
 * Scopes read at once. A `cloudflare-workers` scope is one connected account,
 * so a fleet of accounts would otherwise fire every account's GraphQL read and
 * its D1 writes in the same instant.
 */
export const USAGE_SCOPE_CONCURRENCY = 4;

/** Run `task` over `items`, at most `limit` at a time. `task` handles its own failures. */
const forEachLimited = async <T>(items: ReadonlyArray<T>, limit: number, task: (item: T) => Promise<void>): Promise<void> => {
    const queue = [...items];

    const worker = async (): Promise<void> => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
            // eslint-disable-next-line no-await-in-loop -- each worker runs its share one at a time; that is the cap
            await task(item);
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

/** A `metering: "readback"` fleet as the usage sweep reads it. */
export interface ReadbackFleet {
    id: TargetId;
    usage?: UsageReadback;
}

/** The label of each family's unavailable state: what the Usage tab and the log say. */
const METERING_LABEL: Record<UsageFamily, string> = {
    d1: "storage metering",
    durableObjectDuration: "Durable Object duration metering",
    durableObjectRequests: "Durable Object request metering",
    durableObjects: "storage metering",
    requests: "request metering",
    workersCpu: "CPU metering",
};

/** The label of a family's unavailable state. */
const meteringLabel = (family: UsageFamily): string => METERING_LABEL[family];

/** The callbacks of {@link runReadbackUsageSweep}. */
interface ReadbackSweepOptions {
    now: number;
    /** What the operator should know of a run that succeeded: unattributed volume, a span too old to read. */
    onNote?: (target: TargetId, scopeKey: string, message: string) => void;
    onScopeFailed: (target: TargetId, scope: string, reason: unknown) => void;
    onUnavailable?: (target: TargetId, scope: string, message: string) => void;
}

/** Read one (scope, family) into the ledger, and say how it went — the status the sweep records. */
const readFamily = async (
    database: ControlPlaneStore,
    input: { attribution: ReadonlyMap<string, UsageAttribution>; family: UsageFamily; scope: string; source: UsageSource; target: TargetId },
    options: ReadbackSweepOptions,
): Promise<UsageSourceStatus> => {
    const { attribution, family, scope, source, target } = input;
    const scopeKey = usageScopeKey(scope, family);

    try {
        const ports = await usageRollbackPorts(database, { ...source, scope }, { attribution, family, now: options.now, target });
        const result = await runUsageRollback(ports);
        const gap =
            result.gap === undefined
                ? undefined
                : `usage from ${new Date(result.gap.sinceMs).toISOString()} to ${new Date(result.gap.untilMs).toISOString()} was older than Cloudflare keeps it and was not read`;

        if (result.unattributed > 0) {
            options.onNote?.(target, scopeKey, `${String(result.unattributed)} read for resources no deployment matches (not billed)`);
        }

        if (gap !== undefined) {
            options.onNote?.(target, scopeKey, gap);
        }

        return { kind: "read", unattributedQuantity: result.unattributed, ...(gap === undefined ? {} : { gap }) };
    } catch (error) {
        if (error instanceof UsageUnavailableError) {
            const message = `${meteringLabel(family)} unavailable: ${error.message}`.slice(0, 500);

            options.onUnavailable?.(target, scope, message);

            return { kind: "unavailable", message };
        }

        options.onScopeFailed(target, family === "requests" ? scope : scopeKey, error);

        return { kind: "failed", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
};

/**
 * Fold every readback fleet's usage into `platformUsage`, every (scope, family)
 * delta-read off its own checkpoint. The deployments table is drained ONCE per
 * sweep and each target's attribution map built once from it, then shared by
 * all of that target's scopes — not drained again per scope — and scopes run
 * {@link USAGE_SCOPE_CONCURRENCY} at a time. A scope's families run one after
 * another, each on its own: one whose read throws keeps its checkpoint and is
 * retried next hour, while the others advance.
 *
 * - A read that fails is reported through `onScopeFailed` (scope `*` when a
 *   target's scopes could not be listed) and retried next hour; its error and
 *   since when it has failed are kept in `usageSourceStatus`, so a source that
 *   keeps failing (a persistent 429/5xx, a refused truncated result) is shown
 *   rather than stalling silently.
 * - A run that read reports the volume it could not attribute and any span
 *   older than Cloudflare keeps (`MAX_LOOKBACK_MS`) through `onNote`, and keeps
 *   both in `usageSourceStatus`.
 * - A source that cannot read at all (`UsageUnavailableError`: no dataset to
 *   meter, or a token the account refuses) records "storage metering
 *   unavailable: …" (or "request metering …") in `usageSourceStatus`, which
 *   `usage.meteringStatus` shows, and reports it through `onUnavailable`. It
 *   is never read as zero.
 */
export const runReadbackUsageSweep = async (
    database: ControlPlaneStore,
    fleets: ReadonlyArray<ReadbackFleet>,
    options: ReadbackSweepOptions,
): Promise<void> => {
    const reading = fleets.flatMap(({ id, usage }) => (usage === undefined ? [] : [{ target: id, usage }]));

    if (reading.length === 0) {
        return;
    }

    // Drained: this map attributes metered usage to a deployment, so a resource
    // missing from it is usage that lands on nobody's bill.
    const deploymentRows = await drainTable<AttributionRow>(database, "deployments");
    const perTarget = await Promise.all(
        reading.map(async ({ target, usage }) => {
            const attribution = usageAttributionOf(deploymentRows, target);
            const scopes = await usage.scopes().catch((error: unknown) => {
                options.onScopeFailed(target, "*", error);

                return [];
            });

            return scopes.map((scope) => {
                return { attribution, scope, target, usage };
            });
        }),
    );

    await forEachLimited(perTarget.flat(), USAGE_SCOPE_CONCURRENCY, async ({ attribution, scope, target, usage }) => {
        for (const family of USAGE_FAMILIES) {
            const source = usage.sources[family];

            if (source === undefined) {
                continue;
            }

            const scopeKey = usageScopeKey(scope, family);
            /* eslint-disable no-await-in-loop -- a scope's families run in turn, so their accruals never race each other */
            const status = await readFamily(database, { attribution, family, scope, source, target }, options);

            // Best-effort and separate: the ledger and the checkpoint are already written.
            await recordSourceStatus(database, status, { now: options.now, scopeKey, target }).catch((statusError: unknown) => {
                options.onScopeFailed(target, `${scopeKey} (status)`, statusError);
            });
            /* eslint-enable no-await-in-loop */
        }
    });
};
