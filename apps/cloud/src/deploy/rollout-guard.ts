/**
 * The rollout guard — the every-minute sweep that aborts a staged rollout whose
 * candidate is failing worse than the release it is replacing.
 *
 * **The candidate is judged against the active release, not against a number.**
 * An absolute error-rate threshold is unusable across a platform: an API that
 * legitimately answers 5xx under load and a static site have nothing in common,
 * so any constant is wrong for most apps. The two scripts here are two builds of
 * the SAME app, serving a deterministic split of the same traffic in the same
 * window — which makes the active release the only fair baseline, and makes the
 * comparison self-calibrating for apps this code will never see.
 *
 * Pure over its ports, like the other sweeps: the decision is a function of
 * traffic health and open rollouts, and the edge supplies the AE reader and D1.
 */
import type { ControlPlaneDatabase } from "../store";
import { raiseDeployAlerts } from "../telemetry/deploy-alerts";
import type { ScriptHealth } from "../telemetry/traffic-read";

/**
 * The window each judgement reads.
 *
 * Trailing, not "since the rollout started": a rollout left open for days is
 * judged on how it is behaving now, rather than on an average diluted by every
 * healthy hour before the bad deploy.
 */
export const ROLLOUT_GUARD_WINDOW_MS = 15 * 60 * 1000;

/**
 * Requests a script must have served in the window before its error rate counts.
 *
 * Below this the rate is noise — one 500 out of three requests reads as 33%, and
 * aborting a rollout on three requests would make the guard fire mostly on
 * scanner traffic to a quiet preview.
 *
 * Measured in sample-weighted requests, which is the honest caveat: Analytics
 * Engine retains one row per many past a write rate, so at high volume a single
 * retained row can carry an interval of 100 and this floor is reached with fewer
 * than 20 observations behind it. It still bounds the low-traffic case it exists
 * for, where no sampling is engaged and the count is exact.
 */
export const ROLLOUT_GUARD_MIN_REQUESTS = 20;

/**
 * How much worse than the active release the candidate must be, in percentage
 * points, before it is aborted.
 *
 * A margin rather than "any worse at all": the two scripts see different requests
 * — a deterministic split is not a stratified sample — so a candidate will
 * routinely sit a fraction of a point either side of the active release while
 * being identical in behaviour. Five points is comfortably outside that noise and
 * comfortably inside "this release is broken".
 */
export const ROLLOUT_GUARD_ERROR_MARGIN = 0.05;

/**
 * The error rate at which a candidate is aborted with no baseline to compare to.
 *
 * Reached when the active release served too little traffic in the window to
 * judge against — a low-traffic app, or a rollout sitting at a high percentage.
 * Deliberately a blunt, high number: with no baseline this is the guard saying
 * "whatever normal is for this app, it is not one request in three failing."
 */
export const ROLLOUT_GUARD_ABSOLUTE_ERROR_RATE = 1 / 3;

/**
 * Projects scanned per tick.
 *
 * There is no index for "has a rollout" — the column is a nested optional, and
 * open rollouts are a handful at any moment, so a flag column plus an index to
 * find them would be more machinery than the scan it replaces. Past this many
 * projects the oldest ones fall outside the scan and are silently unguarded; the
 * fix at that size is the flag column, not a bigger number.
 */
export const ROLLOUT_GUARD_MAX_PROJECTS = 1000;

/** An open rollout, as the sweep resolves it from `projects`. */
export interface OpenRollout {
    /** The release the candidate is splitting traffic with; absent if the project has none. */
    activeScriptName?: string;
    candidateScriptName: string;
    organizationId: string;
    percent: number;
    projectId: string;
    /** For the audit entry and the notification. */
    projectName: string;
}

/** A rollout the guard has decided to abort, with the sentence that says why. */
export interface RolloutAbort {
    reason: string;
    rollout: OpenRollout;
}

/** Render a rate as a percentage with one decimal, for the reason line. */
const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/**
 * Decide one rollout's fate from the window's per-script health.
 *
 * Returns the reason to abort, or `null` to leave it running — which is also the
 * answer when there is not enough traffic to have an opinion. Silence here always
 * means "keep serving the candidate", so every early return is a deliberate
 * choice to not act on thin evidence rather than a missing case.
 */
export const judgeRollout = (rollout: OpenRollout, health: ReadonlyMap<string, ScriptHealth>): null | string => {
    const candidate = health.get(rollout.candidateScriptName);

    if (!candidate || candidate.requests < ROLLOUT_GUARD_MIN_REQUESTS) {
        return null;
    }

    const active = rollout.activeScriptName === undefined ? undefined : health.get(rollout.activeScriptName);

    if (active && active.requests >= ROLLOUT_GUARD_MIN_REQUESTS) {
        if (candidate.errorRate > active.errorRate + ROLLOUT_GUARD_ERROR_MARGIN) {
            return (
                `The candidate returned ${percent(candidate.errorRate)} 5xx over the last ` +
                `${String(ROLLOUT_GUARD_WINDOW_MS / 60_000)} minutes (${String(candidate.errors)} of ${String(candidate.requests)} requests), ` +
                `against ${percent(active.errorRate)} for the active release over the same window.`
            );
        }

        return null;
    }

    if (candidate.errorRate > ROLLOUT_GUARD_ABSOLUTE_ERROR_RATE) {
        return (
            `The candidate returned ${percent(candidate.errorRate)} 5xx over the last ` +
            `${String(ROLLOUT_GUARD_WINDOW_MS / 60_000)} minutes (${String(candidate.errors)} of ${String(candidate.requests)} requests). ` +
            `The active release served too little traffic in that window to compare against.`
        );
    }

    return null;
};

/** Judge every open rollout against one health read. */
export const judgeRollouts = (rollouts: ReadonlyArray<OpenRollout>, health: ReadonlyMap<string, ScriptHealth>): RolloutAbort[] => {
    const aborts: RolloutAbort[] = [];

    for (const rollout of rollouts) {
        const reason = judgeRollout(rollout, health);

        if (reason !== null) {
            aborts.push({ reason, rollout });
        }
    }

    return aborts;
};

/**
 * Every script name one health read has to cover, deduplicated.
 *
 * Emitted in candidate/active PAIRS rather than all candidates then all actives,
 * because the query truncates at `MAX_TRAFFIC_SCRIPTS`: interleaved, a rollout
 * that survives the cut keeps both sides of its comparison, so the guard either
 * judges it properly or abstains. Grouped by role, the cut would land between a
 * candidate and its baseline and send it down the no-baseline path — judging it
 * against an absolute threshold while believing it had compared.
 */
export const scriptsToRead = (rollouts: ReadonlyArray<OpenRollout>): string[] => {
    const names = new Set<string>();

    for (const rollout of rollouts) {
        names.add(rollout.candidateScriptName);

        if (rollout.activeScriptName !== undefined && rollout.activeScriptName !== "") {
            names.add(rollout.activeScriptName);
        }
    }

    return [...names];
};

/** A `projects` row as the control-plane store returns it. */
interface ProjectRolloutRow {
    _id: string;
    activeScriptName?: string;
    name: string;
    organizationId: string;
    rollout?: { deploymentId: string; percent: number; scriptName: string };
}

/** The AE read the guard needs, injected so the sweep never touches the network in tests. */
export interface RolloutHealthReader {
    readScriptHealth: (input: { from: number; scriptNames: ReadonlyArray<string>; to: number }) => Promise<Map<string, ScriptHealth>>;
}

export interface RolloutGuardResult {
    /** Rollouts aborted this tick, with the reason recorded against each. */
    aborted: RolloutAbort[];
    /** Open rollouts examined (whether or not they had enough traffic to judge). */
    examined: number;
}

/** Read every open rollout on the platform. */
export const openRollouts = async (database: ControlPlaneDatabase): Promise<OpenRollout[]> => {
    // Newest first. The read defaults to oldest-first, which meant the projects
    // past the page bound were the NEWEST ones — the ones most likely to be
    // mid-deploy, and so exactly the set a rollout guard must not skip.
    const { page } = await database.findMany("projects", { limit: ROLLOUT_GUARD_MAX_PROJECTS, orderBy: [{ _creationTime: "desc" }] });

    return (page as ProjectRolloutRow[])
        .filter((row): row is ProjectRolloutRow & { rollout: NonNullable<ProjectRolloutRow["rollout"]> } => Boolean(row.rollout?.scriptName))
        .map((row) => {
            return {
                candidateScriptName: row.rollout.scriptName,
                organizationId: row.organizationId,
                percent: row.rollout.percent,
                projectId: row._id,
                projectName: row.name,
                ...(row.activeScriptName === undefined ? {} : { activeScriptName: row.activeScriptName }),
            };
        });
};

/**
 * Judge every open rollout and abort the failing ones.
 *
 * Aborting is the same write `abortRollout` performs — clear the rollout, all
 * traffic returns to the active release, the candidate stays `live` so it can be
 * rolled out again after a fix. The audit action is its own (`auto_abort`) so the
 * guard's behaviour is legible in the log it is reviewed from.
 *
 * Nothing is aborted when the AE read fails: no evidence is not evidence of a bad
 * release.
 */
export const runRolloutGuard = async (database: ControlPlaneDatabase, options: { now: number; reader: RolloutHealthReader }): Promise<RolloutGuardResult> => {
    const rollouts = await openRollouts(database);

    if (rollouts.length === 0) {
        return { aborted: [], examined: 0 };
    }

    const { now } = options;
    const health = await options.reader.readScriptHealth({ from: now - ROLLOUT_GUARD_WINDOW_MS, scriptNames: scriptsToRead(rollouts), to: now });
    const aborted = judgeRollouts(rollouts, health);

    const applied: RolloutAbort[] = [];

    for (const abort of aborted) {
        const { reason, rollout } = abort;

        // Re-read and compare before clearing.
        //
        // The judgement spans a network round trip to the AE SQL API, and in that
        // window an operator can abort, fix and start a NEW rollout, or promote the
        // one being judged. Neither is caught by the store's optimistic-concurrency
        // check: `patch` re-reads its own snapshot and builds the compare-and-set
        // from THAT, so a concurrent write is adopted rather than rejected. Without
        // this, the guard clears whichever rollout happens to be there — cancelling
        // a candidate it never looked at, and then paging its operator with the
        // failing numbers of a different one.
        // eslint-disable-next-line no-await-in-loop -- at most a handful of rollouts abort in one tick
        const { page } = await database.findMany("projects", { where: { _id: rollout.projectId } });
        const current = (page as ProjectRolloutRow[])[0];

        if (current?.rollout?.scriptName !== rollout.candidateScriptName) {
            continue;
        }

        applied.push(abort);
        // eslint-disable-next-line no-await-in-loop -- at most a handful of rollouts abort in one tick
        await database.patch(rollout.projectId, { rollout: null }, "projects");
        // eslint-disable-next-line no-await-in-loop -- see above
        await database.insert("auditLog", {
            action: "deployment.rollout.auto_abort",
            actorUserId: "system:rollout-guard",
            createdAt: now,
            organizationId: rollout.organizationId,
            target: `${rollout.candidateScriptName}@${String(rollout.percent)}%`,
        });
        // eslint-disable-next-line no-await-in-loop -- see above
        await raiseDeployAlerts(
            database,
            rollout.organizationId,
            `rollout:${rollout.projectId}:${rollout.candidateScriptName}`,
            { detail: reason, kind: "rollout", project: rollout.projectName, reference: rollout.candidateScriptName },
            now,
        );
    }

    return { aborted: applied, examined: rollouts.length };
};
