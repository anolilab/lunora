/**
 * Emergency stop: halting an organization's projects, and resuming them.
 *
 * A suspension stops new traffic at the dispatcher, but code already running
 * inside a tenant keeps executing and billing — a Durable Object alarm that
 * re-arms itself runs forever. A halt converges each live alias of the
 * organization onto a generated stub release (`./halt-stub.ts`) that keeps
 * every Durable Object class and its data, parks their alarms, and runs none of
 * the tenant's code; a resume converges the alias back onto its live release.
 *
 * Two halves, one converger:
 *
 * - **Intent.** A `halts` row per alias says it should be halted
 *   ({@link requestOrganizationHalt}) or resumed ({@link requestOrganizationResume}).
 *   Owners and admins write it from the studio, support over `POST /v1/halts`,
 *   and {@link syncSuspensionHalts} from the organization's suspension, when
 *   its reason is one `haltOnSuspension` covers ({@link haltsOnSuspension}).
 * - **Converge.** The every-minute sweep ({@link runHaltConverges}) takes a
 *   bounded number of rows whose Worker is not where the row wants it, claims a
 *   lease on each, and converges it through the target driver, paced like any
 *   other converge. The converges themselves are `./halt-converge.ts`.
 *
 * Fail safe in both directions: nothing here reads or writes the suspension,
 * so a failed halt never lifts or changes one, and a failed converge keeps its
 * row, records its error and retries with backoff — logged every time,
 * audit-logged and alerted once. A manual halt is only ever lifted by a person.
 * Box projects (`celld-vps`) are never halted here: a suspension already stops
 * their fleets on the box.
 */
import type { ControlPlaneStore } from "../d1-store";
import type { TargetId } from "../provision-contract";
import { storedTarget, TARGETS } from "../provision-contract";
import { drainTable } from "../store";
import type { AlertChannel, EventRule } from "../telemetry/alerts";
import { fireDeployRules } from "../telemetry/alerts";

/** The message every refused deploy, rollback and release of a halted project gets. */
export const HALTED_REFUSAL = "project halted — resume it first";

/** Suspension reasons `haltOnSuspension` acts on. Never `dunning`: a failed payment must not stop a customer's code. */
export const HALT_ON_SUSPENSION_REASONS: ReadonlySet<string> = new Set(["overage", "spend-cap"]);

/** Who a suspension's halt is recorded as. */
export const SUSPENSION_ACTOR = "system:halt-on-suspension";

/** Who a support halt is recorded as. */
export const SUPPORT_ACTOR = "support";

/** Converges started per tick: a mass suspension spreads over minutes rather than spending the provision box's budget at once. */
export const MAX_HALT_CONVERGES_PER_TICK = 3;

/** How long into a tick a converge may still start: a scheduled invocation's work is cut off after 15 minutes. */
export const HALT_CONVERGE_WINDOW_MS = 8 * 60 * 1000;

/** How long a claimed converge holds its row before another tick may take it over. A provision job runs two Alchemy stacks. */
export const HALT_LEASE_MS = 20 * 60 * 1000;

/** How long an in-flight deploy of an alias defers its stub, so the stub lands after it rather than under it. */
export const IN_FLIGHT_DEFER_MS = 30 * 60 * 1000;

/** The longest wait between retries of a failing converge. */
export const MAX_HALT_BACKOFF_MS = 60 * 60 * 1000;

/** Longest error kept on a row. */
const MAX_ERROR = 512;

export type HaltSource = "manual" | "suspension";

export type HaltState = "halted" | "halting" | "resuming";

/** A `halts` row. */
export interface HaltRow {
    _id: string;
    alias: string;
    attempts?: null | number;
    convergingAt?: null | number;
    createdAt: number;
    deploymentId?: null | string;
    haltedAt?: null | number;
    haltedBy: string;
    kind: string;
    lastError?: null | string;
    nextAttemptAt?: null | number;
    organizationId: string;
    projectId: string;
    reason: string;
    source: HaltSource;
    state: HaltState;
    stubStartedAt?: null | number;
    target: string;
    updatedAt: number;
}

/** A `deployments` row, as far as the halt reads it. */
export interface HaltDeploymentRow {
    _id: string;
    alias?: null | string;
    createdAt: number;
    failedAt?: null | number;
    kind: string;
    liveAt?: null | number;
    organizationId: string;
    placementRef?: null | string;
    projectId: string;
    provisioningAt?: null | number;
    scriptName: string;
    status: string;
    target?: null | string;
    teardownAt?: null | number;
    updatedAt?: null | number;
    verifyingAt?: null | number;
}

/** An `organizations` row, as far as the halt reads it. */
export interface HaltOrganizationRow {
    _id: string;
    haltOnSuspension?: boolean | null;
    suspendedAt?: null | number;
    suspendedReason?: null | string;
}

/** Whether a target's tenants can be halted here. A box's fleets are stopped by the box itself on suspension. */
export const canHalt = (target: TargetId): boolean => TARGETS[target].placedOn !== "box";

/** Whether an organization's suspension halts its projects: a covered reason, and the setting not turned off. */
export const haltsOnSuspension = (organization: HaltOrganizationRow): boolean =>
    organization.suspendedAt != null &&
    organization.suspendedReason != null &&
    HALT_ON_SUSPENSION_REASONS.has(organization.suspendedReason) &&
    organization.haltOnSuspension !== false;

/** The backoff after the `attempts`-th consecutive failure: a minute, doubling, capped at an hour. */
export const haltBackoff = (attempts: number): number => Math.min(MAX_HALT_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR);

const aliasOf = (row: Pick<HaltDeploymentRow, "alias" | "scriptName">): string => row.alias ?? row.scriptName;

/** The release currently live on each alias of `deployments`: the newest `live` row per alias. */
export const liveByAlias = (deployments: ReadonlyArray<HaltDeploymentRow>): Map<string, HaltDeploymentRow> => {
    const live = new Map<string, HaltDeploymentRow>();

    for (const row of deployments) {
        const alias = aliasOf(row);
        const known = live.get(alias);

        if (row.status === "live" && (known === undefined || row.createdAt > known.createdAt)) {
            live.set(alias, row);
        }
    }

    return live;
};

/** Every deployment row of an organization. */
const organizationDeployments = async (database: ControlPlaneStore, organizationId: string): Promise<HaltDeploymentRow[]> =>
    drainTable<HaltDeploymentRow>(database, "deployments", { where: { organizationId } });

const organizationHalts = async (database: ControlPlaneStore, organizationId: string): Promise<HaltRow[]> =>
    drainTable<HaltRow>(database, "halts", { where: { organizationId } });

const audit = async (
    database: ControlPlaneStore,
    input: { action: string; actor: string; now: number; organizationId: string; target: string },
): Promise<void> => {
    await database.insert("auditLog", {
        action: input.action,
        actorUserId: input.actor,
        createdAt: input.now,
        organizationId: input.organizationId,
        target: input.target.slice(0, MAX_ERROR),
    });
};

/** What one halt request did. */
export interface HaltRequestResult {
    /** Aliases newly asked to halt, or asked again after a resume was asked for. */
    halted: string[];
    /** Aliases on a target a halt does not cover (a box), with the reason. */
    unsupported: { alias: string; reason: string }[];
}

/** The reason a box project is not halted, as the studio and the operator route show it. */
export const BOX_HALT_REFUSAL = "runs on your own server; a suspension stops its fleet there, and an emergency stop does not reach it";

/**
 * What a halt request changes on an alias that already has a row: a `manual`
 * request takes a suspension's row over, and a `resuming` row is turned back
 * — by a manual request, or by a suspension request for its own row. A
 * suspension request never touches a manual row. `undefined`: nothing changes.
 */
const haltAgain = (row: HaltRow, request: { actor: string; source: HaltSource }): Record<string, unknown> | undefined => {
    const takeOver = request.source === "manual" && row.source === "suspension";
    const reHalt = row.state === "resuming" && (request.source === "manual" || row.source === "suspension");

    if (!takeOver && !reHalt) {
        return undefined;
    }

    return {
        ...(takeOver ? { haltedBy: request.actor, source: request.source } : {}),
        ...(reHalt ? { attempts: 0, lastError: null, nextAttemptAt: null, state: "halting" } : {}),
    };
};

/**
 * Ask for every live alias of an organization to be halted: insert a `halting`
 * row per alias that has none, and turn a `resuming` row back. A `manual` request
 * takes over a suspension's rows, so they are no longer lifted with the
 * suspension; a `suspension` request leaves every other row as it is.
 * Converging is the sweep's ({@link runHaltConverges}).
 */
export const requestOrganizationHalt = async (
    database: ControlPlaneStore,
    input: { actor: string; now: number; organizationId: string; reason: string; source: HaltSource },
): Promise<HaltRequestResult> => {
    const { actor, now, organizationId, reason, source } = input;
    const [deployments, halts] = await Promise.all([organizationDeployments(database, organizationId), organizationHalts(database, organizationId)]);
    const existing = new Map(halts.map((row) => [row.alias, row]));
    const result: HaltRequestResult = { halted: [], unsupported: [] };

    for (const [alias, live] of liveByAlias(deployments)) {
        const target = storedTarget(live.target);

        if (target === undefined || !canHalt(target)) {
            result.unsupported.push({ alias, reason: BOX_HALT_REFUSAL });
            continue;
        }

        const row = existing.get(alias);

        if (row === undefined) {
            // eslint-disable-next-line no-await-in-loop -- a handful of aliases per organization; sequential keeps the writer simple
            await database.insert("halts", {
                alias,
                createdAt: now,
                haltedBy: actor,
                kind: live.kind,
                organizationId,
                projectId: live.projectId,
                reason,
                source,
                state: "halting",
                target,
                updatedAt: now,
            });
            result.halted.push(alias);
            continue;
        }

        const patch = haltAgain(row, { actor, source });

        if (patch !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- see above
            await database.patch(row._id, { ...patch, updatedAt: now }, "halts");

            if (patch.state === "halting") {
                result.halted.push(alias);
            }
        }
    }

    if (result.halted.length > 0) {
        await audit(database, { action: "halt.requested", actor, now, organizationId, target: `${source}: ${result.halted.join(", ")}` });
    }

    return result;
};

/**
 * Ask for an organization's halted aliases to be resumed — every one, or only
 * those `source` halted. Converging is the sweep's; a row is deleted once its
 * alias runs its live release again.
 */
export const requestOrganizationResume = async (
    database: ControlPlaneStore,
    input: { actor: string; now: number; organizationId: string; source?: HaltSource },
): Promise<{ resumed: string[] }> => {
    const { actor, now, organizationId } = input;
    const halts = await organizationHalts(database, organizationId);
    const rows = halts.filter((row) => row.state !== "resuming" && (input.source === undefined || row.source === input.source));

    for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop -- a handful of aliases per organization; sequential keeps the writer simple
        await database.patch(row._id, { attempts: 0, lastError: null, nextAttemptAt: null, state: "resuming", updatedAt: now }, "halts");
    }

    const resumed = rows.map((row) => row.alias);

    if (resumed.length > 0) {
        await audit(database, { action: "halt.resume_requested", actor, now, organizationId, target: resumed.join(", ") });
    }

    return { resumed };
};

/**
 * Whether this control plane converges an organization's tenants: its
 * organization is placed on this control plane's cell. Every cell runs the
 * halt sweep over the same rows, so a sweep acts only on its own cell's
 * organizations and leaves the rest, silently, to theirs.
 */
export type OwnsOrganization = (organizationId: string) => Promise<boolean>;

/** A single-cell deployment's answer: every organization is this control plane's. */
const everyOrganization: OwnsOrganization = () => Promise.resolve(true);

/** The organizations among `ids` that `owns` answers for, each asked once. */
const ownedBy = async (owns: OwnsOrganization, ids: ReadonlyArray<string>): Promise<Set<string>> => {
    const unique = [...new Set(ids)];
    const answers = await Promise.all(unique.map(async (id) => ((await owns(id)) ? id : undefined)));

    return new Set(answers.filter((id): id is string => id !== undefined));
};

/**
 * When a deployment's converge finished, as far as its row says: the phase it
 * reached after the converge (`verifying`, `failed`, `live`), else its last write.
 */
const convergeFinishedAt = (deployment: HaltDeploymentRow): number => {
    const phases = [deployment.verifyingAt, deployment.failedAt, deployment.liveAt].filter((at): at is number => at != null);

    return phases.length > 0 ? Math.max(...phases) : (deployment.updatedAt ?? deployment.createdAt);
};

/**
 * Converge halts onto suspensions (`haltOnSuspension`), idempotently: halt the
 * live aliases of every organization whose suspension halts it, and resume the
 * suspension halts of every organization whose suspension no longer does —
 * lifted, changed to a reason the setting does not cover, or the setting
 * turned off. Manual halts are never resumed here. Reads the suspension, never
 * writes it.
 */
export const syncSuspensionHalts = async (
    database: ControlPlaneStore,
    now: number,
    owns: OwnsOrganization = everyOrganization,
): Promise<{ halted: number; resumed: number }> => {
    const [suspended, halts] = await Promise.all([
        drainTable<HaltOrganizationRow>(database, "organizations", { where: { suspendedAt: { gt: 0 } } }),
        drainTable<HaltRow>(database, "halts", { where: { source: "suspension" } }),
    ]);
    const owned = await ownedBy(owns, [...suspended.map((organization) => organization._id), ...halts.map((row) => row.organizationId)]);
    const halting = suspended.filter((organization) => owned.has(organization._id) && haltsOnSuspension(organization));
    const haltingIds = new Set(halting.map((organization) => organization._id));
    let halted = 0;

    for (const organization of halting) {
        // eslint-disable-next-line no-await-in-loop -- one organization at a time keeps the writer simple
        const result = await requestOrganizationHalt(database, {
            actor: SUSPENSION_ACTOR,
            now,
            organizationId: organization._id,
            reason: organization.suspendedReason ?? "suspended",
            source: "suspension",
        });

        halted += result.halted.length;
    }

    const lifted = new Set(
        halts
            .filter((row) => row.state !== "resuming" && owned.has(row.organizationId) && !haltingIds.has(row.organizationId))
            .map((row) => row.organizationId),
    );
    let resumed = 0;

    for (const organizationId of lifted) {
        // eslint-disable-next-line no-await-in-loop -- see above
        const result = await requestOrganizationResume(database, { actor: SUSPENSION_ACTOR, now, organizationId, source: "suspension" });

        resumed += result.resumed.length;
    }

    return { halted, resumed };
};

/** What converging one row did. `skipped`: the alias has no live release, so there is nothing to stop or restore. */
export type HaltConvergeOutcome = { deploymentId: string } | { skipped: string };

/** The converges the sweep drives, and where it reports. */
export interface HaltConvergePorts {
    /** Raise the organization's `deploy` alerts for a halted alias, or a converge that keeps failing. Best-effort. */
    alert?: (row: HaltRow, event: "failed" | "halted", detail: string) => Promise<void>;
    /** The clock `startBefore` is read on; `Date.now` by default. */
    clock?: () => number;
    /** Converge the alias onto its stub. */
    halt: (row: HaltRow) => Promise<HaltConvergeOutcome>;
    /** Converges started per tick; {@link MAX_HALT_CONVERGES_PER_TICK} by default. */
    limit?: number;
    log: (line: string) => void;
    now: number;
    /** Whether this control plane converges an organization's tenants ({@link OwnsOrganization}); all of them by default. */
    owns?: OwnsOrganization;
    /** Converge the alias back onto its live release. */
    resume: (row: HaltRow) => Promise<HaltConvergeOutcome>;
    /** Start no converge once the clock passes this (epoch ms); absent → no bound. */
    startBefore?: number;
}

/** What one sweep tick did. */
export interface HaltSweepResult {
    deferred: number;
    failed: number;
    halted: number;
    resumed: number;
}

const IN_FLIGHT = new Set(["provisioning", "verifying"]);

/**
 * Which rows to converge this tick, and which wait for an in-flight deploy:
 *
 * - `halting` and `resuming` rows whose backoff is over and whose lease is free;
 * - `halted` rows a release may have converged on top of — a converge of the
 *   alias that finished after the stub's started (one already running when the
 *   stub went on, past the in-flight wait) — which get their stub again;
 * - a stub waits while a deploy of its alias is still in flight, so it lands
 *   after the deploy rather than under it.
 */
const planConverges = async (
    database: ControlPlaneStore,
    rows: ReadonlyArray<HaltRow>,
    options: { now: number; owns: OwnsOrganization },
): Promise<{ deferred: number; due: { mode: "halt" | "resume"; row: HaltRow }[] }> => {
    const { now } = options;
    const owned = await ownedBy(
        options.owns,
        rows.map((row) => row.organizationId),
    );
    const candidates = rows.filter(
        (row) =>
            owned.has(row.organizationId) &&
            (row.convergingAt == null || now - row.convergingAt >= HALT_LEASE_MS) &&
            (row.nextAttemptAt == null || row.nextAttemptAt <= now),
    );
    const projects = [...new Set(candidates.filter((row) => row.state !== "resuming").map((row) => row.projectId))];
    const deployments = new Map<string, HaltDeploymentRow[]>();

    for (const projectId of projects) {
        // eslint-disable-next-line no-await-in-loop -- one project's rows per read; few projects are ever halted at once
        deployments.set(projectId, await drainTable<HaltDeploymentRow>(database, "deployments", { where: { projectId } }));
    }

    let deferred = 0;
    const due: { mode: "halt" | "resume"; row: HaltRow }[] = [];

    for (const row of candidates) {
        if (row.state === "resuming") {
            due.push({ mode: "resume", row });
            continue;
        }

        const ofAlias = (deployments.get(row.projectId) ?? []).filter((deployment) => aliasOf(deployment) === row.alias);
        const inFlight = ofAlias.some(
            (deployment) => IN_FLIGHT.has(deployment.status) && now - (deployment.updatedAt ?? deployment.createdAt) < IN_FLIGHT_DEFER_MS,
        );
        const landedOnTop =
            row.state === "halted" &&
            ofAlias.some((deployment) => deployment.provisioningAt != null && convergeFinishedAt(deployment) >= (row.stubStartedAt ?? 0));

        if (row.state === "halted" && !landedOnTop) {
            continue;
        }

        if (inFlight) {
            deferred += 1;
            continue;
        }

        due.push({ mode: "halt", row });
    }

    return { deferred, due: due.toSorted((a, b) => a.row.createdAt - b.row.createdAt) };
};

/** Record a failed converge: error, attempts and backoff on the row; logged every time, audited and alerted on the first of a run. */
const recordFailure = async (database: ControlPlaneStore, ports: HaltConvergePorts, row: HaltRow, mode: "halt" | "resume", error: unknown): Promise<void> => {
    const message = messageOf(error);
    const attempts = (row.attempts ?? 0) + 1;

    ports.log(`[halt] ${mode} of ${row.alias} failed (attempt ${String(attempts)}): ${message}`);
    await database
        .patch(row._id, { attempts, convergingAt: null, lastError: message, nextAttemptAt: ports.now + haltBackoff(attempts), updatedAt: ports.now }, "halts")
        .catch(() => undefined);

    if (row.lastError == null) {
        await audit(database, {
            action: `halt.${mode}_failed`,
            actor: "system:halt-sweep",
            now: ports.now,
            organizationId: row.organizationId,
            target: `${row.alias}: ${message}`,
        }).catch(() => undefined);
        await ports
            .alert?.(row, "failed", `The ${mode === "halt" ? "emergency stop" : "resume"} of ${row.alias} failed and is retried with backoff: ${message}`)
            .catch(() => undefined);
    }
};

/** Settle a successful halt converge, unless the row changed under it (a resume was asked for meanwhile). */
const settleHalted = async (database: ControlPlaneStore, ports: HaltConvergePorts, row: HaltRow, outcome: HaltConvergeOutcome): Promise<void> => {
    const current = (await database.get(row._id, "halts")) as HaltRow | null;

    if ("skipped" in outcome) {
        if (current !== null && current.state !== "resuming") {
            await database.delete(row._id, "halts");
            await audit(database, {
                action: "halt.skipped",
                actor: "system:halt-sweep",
                now: ports.now,
                organizationId: row.organizationId,
                target: `${row.alias}: ${outcome.skipped}`,
            });
        }

        return;
    }

    if (current === null || current.state === "resuming") {
        // A resume was asked for while the stub converged: the next tick restores the release.
        await (current === null
            ? Promise.resolve()
            : database.patch(row._id, { convergingAt: null, deploymentId: outcome.deploymentId, updatedAt: ports.now }, "halts"));

        return;
    }

    await database.patch(
        row._id,
        {
            attempts: 0,
            convergingAt: null,
            deploymentId: outcome.deploymentId,
            haltedAt: ports.now,
            lastError: null,
            nextAttemptAt: null,
            state: "halted",
            updatedAt: ports.now,
        },
        "halts",
    );
    await audit(database, {
        action: "halt.halted",
        actor: "system:halt-sweep",
        now: ports.now,
        organizationId: row.organizationId,
        target: `${row.alias} (${row.reason})`,
    });

    if (row.state === "halting") {
        await ports
            .alert?.(row, "halted", `${row.alias} was halted (${row.reason}): its Worker runs a stub that keeps its data and parks its Durable Object alarms.`)
            .catch(() => undefined);
    }
};

/** Settle a successful resume, unless a halt was asked for again while it converged. */
const settleResumed = async (database: ControlPlaneStore, ports: HaltConvergePorts, row: HaltRow, outcome: HaltConvergeOutcome): Promise<void> => {
    const current = (await database.get(row._id, "halts")) as HaltRow | null;

    if (current === null) {
        return;
    }

    if (current.state !== "resuming") {
        // Halted again mid-resume: the release is back on the Worker, so the stub goes on again.
        await database.patch(row._id, { convergingAt: null, state: "halting", updatedAt: ports.now }, "halts");

        return;
    }

    await database.delete(row._id, "halts");
    await audit(database, {
        action: "halt.resumed",
        actor: "system:halt-sweep",
        now: ports.now,
        organizationId: row.organizationId,
        target: "skipped" in outcome ? `${row.alias}: ${outcome.skipped}` : `${row.alias} (release ${outcome.deploymentId})`,
    });
};

/**
 * One tick of the halt sweep: converge at most `limit` rows whose Worker is
 * not where the row wants it, each under a lease, one at a time.
 */
export const runHaltConverges = async (database: ControlPlaneStore, ports: HaltConvergePorts): Promise<HaltSweepResult> => {
    const rows = await drainTable<HaltRow>(database, "halts");
    const { deferred, due } = await planConverges(database, rows, { now: ports.now, owns: ports.owns ?? everyOrganization });
    const result: HaltSweepResult = { deferred, failed: 0, halted: 0, resumed: 0 };

    const clock = ports.clock ?? Date.now;

    for (const { mode, row: planned } of due.slice(0, ports.limit ?? MAX_HALT_CONVERGES_PER_TICK)) {
        if (ports.startBefore !== undefined && clock() >= ports.startBefore) {
            break;
        }

        // The row as planned: what it was before this tick wrote to it decides what the settle reports.
        const row = { ...planned };

        // eslint-disable-next-line no-await-in-loop -- one converge at a time keeps the provision box's budget flat
        await database.patch(row._id, { convergingAt: ports.now, ...(mode === "halt" ? { stubStartedAt: ports.now } : {}), updatedAt: ports.now }, "halts");

        try {
            // eslint-disable-next-line no-await-in-loop -- see above
            const outcome = await (mode === "halt" ? ports.halt(row) : ports.resume(row));

            // eslint-disable-next-line no-await-in-loop -- see above
            await (mode === "halt" ? settleHalted(database, ports, row, outcome) : settleResumed(database, ports, row, outcome));
            result[mode === "halt" ? "halted" : "resumed"] += 1;
        } catch (error) {
            // eslint-disable-next-line no-await-in-loop -- see above
            await recordFailure(database, ports, row, mode, error);
            result.failed += 1;
        }
    }

    return result;
};

interface DeployRuleRow {
    _id: string;
    channel: AlertChannel;
    destination: string;
    enabled: boolean;
    name: string;
}

/**
 * The sweep's alert port over the store: fire the organization's enabled
 * `deploy` rules for a halted alias or a failing converge. The rows are
 * delivered by the every-minute alert drain, as the release path's own are.
 */
export const deployRuleAlert =
    (database: ControlPlaneStore, now: number): NonNullable<HaltConvergePorts["alert"]> =>
    async (row, event, detail) => {
        const { page } = await database.findMany("alertRules", { where: { organizationId: row.organizationId, target: "deploy" } });
        const rules: EventRule[] = (page as DeployRuleRow[])
            .filter((rule) => rule.enabled)
            .map((rule) => {
                return { channel: rule.channel, destination: rule.destination, name: rule.name, ruleId: rule._id };
            });
        const project = (await database.get(row.projectId, "projects")) as null | { name?: string };

        await fireDeployRules(
            rules,
            { detail, kind: event === "halted" ? "halt" : "halt_failed", project: project?.name ?? "project", reference: row.alias },
            { hash: `halt:${event}:${row._id}:${String(now)}`, now, organizationId: row.organizationId },
            async (alert) => database.insert("alerts", alert),
        );
    };
