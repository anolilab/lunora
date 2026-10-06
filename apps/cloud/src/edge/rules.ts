/**
 * The edge-rule reconciler (plan 365 W7): the ONLY code that writes an
 * organization's rules to the platform edge. Everything else — the studio's
 * DDoS sensitivity and rate-limit settings (`lunora/edge.ts`), and the anomaly
 * sweep engaging a rate limit ({@link engageAnomalyRateLimits}) — records intent
 * on the `edgeRules` row (`status: "pending"`), and this converges the edge onto it.
 *
 * Intent first: the row is written before the edge is called, so a write that
 * fails, or a crash between the edge's answer and the row update, is never a
 * rule nobody recorded. Every outcome — applied, removed, failed, unavailable —
 * lands on the row and in the audit log.
 *
 * Nothing is trusted from an earlier pass:
 *
 * - **Hostnames** are re-derived every pass, for every applied rule, from the
 *   organization's CURRENT deployment and domain rows, each bound to its row id
 *   and project (`EdgeTarget`). A row deleted, moved to another project, or
 *   re-created for the same hostname under another organization changes that
 *   set, and the rule is re-applied without it within a minute. A rule never
 *   keeps covering a hostname its organization no longer holds.
 * - **Cloudflare ids** are never remembered for a write: the edge re-reads the
 *   zone and finds the rule by this organization's ref each time (see
 *   `src/targets/cloudflare-wfp/edge.ts`).
 * - **The row itself** is re-read just before the write, and the write is
 *   skipped if it changed hands or changed since this pass read it.
 *
 * Bounded: one rule per (organization, kind); at most the cell's budget of each
 * kind applied at once ({@link edgeBudget}); {@link MAX_EDGE_HOSTNAMES}
 * hostnames per rule; {@link MAX_EDGE_WRITES} edge writes per pass. Fails closed:
 * no edge, no budget, too many hostnames or an unknown shape leaves the rule
 * unapplied and says why.
 */
import type { ControlPlaneStore } from "../d1-store";
import { drainTable } from "../store";
import type { OrganizationAnomalyTransition } from "../telemetry/anomaly-sweep";
import type { EdgeProtection, EdgeRuleConfig, EdgeRuleKind, EdgeTarget } from "./protection";
import { MAX_EDGE_HOSTNAMES, organizationHostnames } from "./protection";

/** An `edgeRules` row. */
export interface EdgeRuleRow {
    _id: string;
    /** Whether the edge holds the rule, as last confirmed. */
    applied: boolean;
    /** `rate_limit`: the organization opted in to anomaly-triggered rate limiting. */
    armed?: boolean;
    attempts: number;
    /** `rate_limit`: a usage anomaly is currently firing for the organization. */
    engaged?: boolean;
    kind: EdgeRuleKind;
    organizationId: string;
    periodSeconds?: 10 | 60;
    requestsPerPeriod?: number;
    sensitivity?: "default" | "low" | "medium";
    status: "applied" | "failed" | "pending" | "removed" | "unavailable";
    /** What the applied rule covers, each hostname bound to its row. */
    targets: EdgeTarget[];
    updatedAt: number;
}

type Outcome = EdgeRuleRow["status"] | "skipped";

/** Edge writes per pass, so one tick's Cloudflare calls stay bounded. Checks that find no drift are free. */
export const MAX_EDGE_WRITES = 25;

/** A failed row is retried after `attempts × this`, capped at an hour. */
const RETRY_STEP_MS = 5 * 60 * 1000;

/** After this many failures a row waits for a new intent — unless its rule must come OFF, which is retried forever. */
export const MAX_EDGE_ATTEMPTS = 12;

export interface EdgeRuleOptions {
    appDomain: string;
    budgets: Record<EdgeRuleKind, number>;
    /** The platform edge; absent on a cell without the zone and token. */
    edge?: EdgeProtection;
    now: number;
    /** Also re-check unavailable rows (hourly): a budget freed, or a zone configured since. */
    recheckUnavailable: boolean;
}

/** The config a row asks the edge to hold, or `null` for none. An unknown shape asks for none (fail closed). */
export const desiredConfig = (row: EdgeRuleRow, deleting: boolean): EdgeRuleConfig | null => {
    if (deleting) {
        return null;
    }

    if (row.kind === "ddos_l7") {
        return row.sensitivity === "medium" || row.sensitivity === "low" ? { kind: "ddos_l7", sensitivity: row.sensitivity } : null;
    }

    if (row.kind === "rate_limit" && row.armed === true && row.engaged === true && row.requestsPerPeriod !== undefined && row.periodSeconds !== undefined) {
        return { kind: "rate_limit", periodSeconds: row.periodSeconds, requestsPerPeriod: row.requestsPerPeriod };
    }

    return null;
};

const isDue = (row: EdgeRuleRow, options: EdgeRuleOptions, deleting: boolean): boolean => {
    // An applied rule is re-checked every pass: its hostnames may have moved.
    if (row.status === "pending" || row.applied) {
        return true;
    }

    if (row.status === "failed") {
        // A rule of an organization being erased must come off whatever it costs.
        const capped = !deleting && row.attempts >= MAX_EDGE_ATTEMPTS;

        return !capped && options.now - row.updatedAt >= Math.min(row.attempts * RETRY_STEP_MS, 60 * 60 * 1000);
    }

    return options.recheckUnavailable && row.status === "unavailable";
};

const targetKey = (target: EdgeTarget): string => `${target.hostname}|${target.rowId}|${target.projectId}|${target.source}`;

const sameTargets = (left: ReadonlyArray<EdgeTarget>, right: ReadonlyArray<EdgeTarget>): boolean =>
    left.map((target) => targetKey(target)).join("\n") === right.map((target) => targetKey(target)).join("\n");

/** A bounded reason for the row and the audit log. The edge's errors never carry the token. */
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : "unknown error").slice(0, 300);

/** Patch the row with its outcome and append the matching audit entry. */
const recordOutcome = async (
    database: ControlPlaneStore,
    row: EdgeRuleRow,
    now: number,
    outcome: { audit: string; detail: string; fields: Record<string, unknown>; status: EdgeRuleRow["status"] },
): Promise<EdgeRuleRow["status"]> => {
    await database.patch(row._id, { ...outcome.fields, status: outcome.status, updatedAt: now }, "edgeRules");
    await database.insert("auditLog", {
        action: `edge.${row.kind}.${outcome.audit}`,
        actorUserId: "system:edge-rules",
        createdAt: now,
        organizationId: row.organizationId,
        target: outcome.detail.slice(0, 256),
    });

    return outcome.status;
};

/** The org's current targets on the platform edge, from its own rows. */
const targetsOf = async (database: ControlPlaneStore, organizationId: string, appDomain: string): Promise<EdgeTarget[]> => {
    const [deployments, domains, projects] = await Promise.all([
        drainTable<never>(database, "deployments", { where: { organizationId, status: "live" } }),
        drainTable<never>(database, "domains", { where: { organizationId } }),
        drainTable<never>(database, "projects", { where: { organizationId } }),
    ]);

    return organizationHostnames({ appDomain, deployments, domains, organizationId, projects }).targets;
};

/** Why a wanted rule cannot be applied, or `undefined` when it can. */
const refusalOf = (
    row: EdgeRuleRow,
    targets: ReadonlyArray<EdgeTarget>,
    options: EdgeRuleOptions,
    appliedOfKind: Map<EdgeRuleKind, number>,
): string | undefined => {
    if (new Set(targets.map((target) => target.hostname)).size > MAX_EDGE_HOSTNAMES) {
        return `an edge rule covers at most ${String(MAX_EDGE_HOSTNAMES)} hostnames`;
    }

    const budget = options.budgets[row.kind];

    if (!row.applied && (appliedOfKind.get(row.kind) ?? 0) >= budget) {
        return budget === 0 ? `${row.kind} rules are not enabled on this cell` : `this cell's ${row.kind} rule budget (${String(budget)}) is in use`;
    }

    return undefined;
};

/**
 * Whether the row is still the one this pass planned against: same organization
 * and kind, and not re-written since. A row that changed is left for the next
 * pass, which plans against its new intent; a row that is gone is not written for.
 */
const stillCurrent = async (database: ControlPlaneStore, row: EdgeRuleRow): Promise<boolean> => {
    const fresh = (await database.get(row._id, "edgeRules")) as EdgeRuleRow | null;

    return fresh !== null && fresh.organizationId === row.organizationId && fresh.kind === row.kind && fresh.updatedAt === row.updatedAt;
};

/** Call the edge and record what happened. */
const applyAndRecord = async (
    database: ControlPlaneStore,
    row: EdgeRuleRow,
    edge: EdgeProtection,
    input: { appliedOfKind: Map<EdgeRuleKind, number>; config: EdgeRuleConfig | null; now: number; organizationGone: boolean; targets: EdgeTarget[] },
): Promise<Outcome> => {
    const { appliedOfKind, config, now, organizationGone, targets } = input;
    const hostnames = [...new Set(targets.map((target) => target.hostname))];
    const wanted = config !== null && hostnames.length > 0;

    if (!(await stillCurrent(database, row))) {
        return "skipped";
    }

    try {
        const result = await edge.apply({ config, hostnames, kind: row.kind, organizationId: row.organizationId });

        appliedOfKind.set(row.kind, Math.max((appliedOfKind.get(row.kind) ?? 0) + Number(wanted) - Number(row.applied), 0));

        if (wanted) {
            return await recordOutcome(database, row, now, {
                audit: "applied",
                detail: `${String(hostnames.length)} hostnames`,
                fields: { applied: true, appliedAt: now, attempts: 0, cloudflareRuleId: result.ruleId ?? null, lastError: null, targets },
                status: "applied",
            });
        }

        if (organizationGone) {
            // The organization was purged while its rule was still on the zone; with
            // the rule gone, nothing is left for this row to name.
            await database.delete(row._id, "edgeRules");
            await database.insert("auditLog", {
                action: `edge.${row.kind}.removed`,
                actorUserId: "system:edge-rules",
                createdAt: now,
                organizationId: row.organizationId,
                target: "organization erased",
            });

            return "removed";
        }

        return await recordOutcome(database, row, now, {
            audit: "removed",
            detail: config === null ? "rule removed" : "no hostnames",
            fields: {
                applied: false,
                attempts: 0,
                cloudflareRuleId: null,
                lastError: config === null ? null : "no hostnames are served through the platform edge",
                targets: [],
            },
            status: config === null ? "removed" : "unavailable",
        });
    } catch (error) {
        // `applied` is left as it was: the edge's answer is unknown, and the next
        // pass converges by ref either way.
        return recordOutcome(database, row, now, {
            audit: "failed",
            detail: reasonOf(error),
            fields: { attempts: row.attempts + 1, lastError: reasonOf(error) },
            status: "failed",
        });
    }
};

/** Per-pass state: the applied count per kind, and the edge-write allowance (`takeWrite` answers false once spent). */
interface PassState {
    appliedOfKind: Map<EdgeRuleKind, number>;
    takeWrite: () => boolean;
}

/** Take an applied rule off the edge because it can no longer be held, and say why. */
const reconcileRemoval = async (
    database: ControlPlaneStore,
    row: EdgeRuleRow,
    edge: EdgeProtection,
    input: PassState & { now: number; refusal: string },
): Promise<Outcome> => {
    if (!(await stillCurrent(database, row)) || !input.takeWrite()) {
        return "skipped";
    }

    try {
        await edge.apply({ config: null, hostnames: [], kind: row.kind, organizationId: row.organizationId });
        input.appliedOfKind.set(row.kind, Math.max((input.appliedOfKind.get(row.kind) ?? 1) - 1, 0));

        return await recordOutcome(database, row, input.now, {
            audit: "unavailable",
            detail: input.refusal,
            fields: { applied: false, cloudflareRuleId: null, lastError: input.refusal, targets: [] },
            status: "unavailable",
        });
    } catch (error) {
        return recordOutcome(database, row, input.now, {
            audit: "failed",
            detail: reasonOf(error),
            fields: { attempts: row.attempts + 1, lastError: reasonOf(error) },
            status: "failed",
        });
    }
};

/**
 * A cell without an edge: nothing to call. A rule never applied needs nothing;
 * an applied one stays recorded as applied-but-unreachable, never silently forgotten.
 */
const recordWithoutEdge = async (database: ControlPlaneStore, row: EdgeRuleRow, config: EdgeRuleConfig | null, now: number): Promise<Outcome> => {
    if (config === null && !row.applied) {
        return row.status === "removed"
            ? "skipped"
            : recordOutcome(database, row, now, { audit: "removed", detail: "no rule requested", fields: { attempts: 0, lastError: null }, status: "removed" });
    }

    return row.status === "unavailable"
        ? "skipped"
        : recordOutcome(database, row, now, {
              audit: "unavailable",
              detail: "edge not configured",
              fields: { lastError: "edge rules are not configured on this cell (LUNORA_SAAS_ZONE_ID / CLOUDFLARE_API_TOKEN)" },
              status: "unavailable",
          });
};

/** Reconcile one row. At the pass's write cap, a row that needs a write waits for the next pass. */
const reconcileRow = async (
    database: ControlPlaneStore,
    row: EdgeRuleRow,
    options: EdgeRuleOptions,
    state: PassState & { deleting: boolean; organizationGone: boolean },
): Promise<Outcome> => {
    const { edge, now } = options;
    const config = desiredConfig(row, state.deleting);

    if (edge === undefined) {
        return recordWithoutEdge(database, row, config, now);
    }

    if (config === null && !row.applied && row.status === "removed") {
        return "skipped";
    }

    const targets = config === null ? [] : await targetsOf(database, row.organizationId, options.appDomain);
    const refusal = config === null ? undefined : refusalOf(row, targets, options, state.appliedOfKind);

    if (refusal !== undefined) {
        // A rule already applied that can no longer be held must come off, not linger.
        return row.applied
            ? reconcileRemoval(database, row, edge, { ...state, now, refusal })
            : recordOutcome(database, row, now, { audit: "unavailable", detail: refusal, fields: { lastError: refusal }, status: "unavailable" });
    }

    if (config !== null && row.status === "applied" && row.applied && sameTargets(row.targets, targets)) {
        return "skipped";
    }

    return state.takeWrite()
        ? applyAndRecord(database, row, edge, { appliedOfKind: state.appliedOfKind, config, now, organizationGone: state.organizationGone, targets })
        : "skipped";
};

/** One reconcile pass; answers how many rows reached each outcome. */
export const runEdgeRuleSweep = async (database: ControlPlaneStore, options: EdgeRuleOptions): Promise<Partial<Record<Outcome, number>>> => {
    const rows = await drainTable<EdgeRuleRow>(database, "edgeRules");
    const appliedOfKind = new Map<EdgeRuleKind, number>();

    for (const row of rows) {
        if (row.applied) {
            appliedOfKind.set(row.kind, (appliedOfKind.get(row.kind) ?? 0) + 1);
        }
    }

    const counts: Partial<Record<Outcome, number>> = {};
    let writes = 0;
    const takeWrite = (): boolean => {
        writes += 1;

        return writes <= MAX_EDGE_WRITES;
    };

    for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop -- serialized so the budget and write counts stay exact across rows
        const organization = (await database.get(row.organizationId, "organizations")) as null | { deletionRequestedAt?: null | number };
        const organizationGone = organization === null;
        // A missing organization counts as deleting: its rule must come off.
        const deleting = organizationGone || organization.deletionRequestedAt != null;

        if (!isDue(row, options, deleting)) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- see above
        const outcome = await reconcileRow(database, row, options, { appliedOfKind, deleting, organizationGone, takeWrite });

        counts[outcome] = (counts[outcome] ?? 0) + 1;
    }

    return counts;
};

/**
 * The anomaly → rate-limit action: after an anomaly pass, re-derive whether each
 * transitioning organization has a usage anomaly firing, and record that as
 * intent on its armed `rate_limit` row. The reconciler applies it.
 *
 * Engaged while ANY enabled `usage_anomaly` rule of the organization is latched
 * firing, so two rules at different thresholds cannot release a limit the
 * higher one still wants. The organization id comes from the rule rows the
 * transitions were evaluated over, never from a caller.
 */
export const engageAnomalyRateLimits = async (
    database: ControlPlaneStore,
    transitions: ReadonlyArray<OrganizationAnomalyTransition>,
    now: number,
): Promise<number> => {
    let changed = 0;

    for (const organizationId of new Set(
        transitions.filter((transition) => transition.target === "usage_anomaly").map((transition) => transition.organizationId),
    )) {
        /* eslint-disable no-await-in-loop -- a handful of orgs per hourly pass */
        const { page } = await database.findMany("edgeRules", { where: { kind: "rate_limit", organizationId } });
        const row = (page as EdgeRuleRow[])[0];

        if (row?.armed !== true) {
            continue;
        }

        const [{ page: rules }, { page: states }] = await Promise.all([
            database.findMany("alertRules", { where: { enabled: true, organizationId, target: "usage_anomaly" } }),
            database.findMany("alertRuleState", { where: { firing: true, organizationId } }),
        ]);
        const usageRuleIds = new Set((rules as { _id: string }[]).map((rule) => rule._id));
        const engaged = (states as { ruleId: string }[]).some((state) => usageRuleIds.has(state.ruleId));

        if (engaged === (row.engaged === true)) {
            continue;
        }

        await database.patch(row._id, { attempts: 0, engaged, status: "pending", updatedAt: now }, "edgeRules");
        await database.insert("auditLog", {
            action: engaged ? "edge.rate_limit.engage" : "edge.rate_limit.release",
            actorUserId: "system:anomaly",
            createdAt: now,
            organizationId,
            target: engaged ? "usage anomaly firing" : "usage anomaly cleared",
        });
        /* eslint-enable no-await-in-loop */
        changed += 1;
    }

    return changed;
};
