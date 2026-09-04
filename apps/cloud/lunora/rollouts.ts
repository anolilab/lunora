import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { mutation, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { rateLimit } from "./guards";

/**
 * Staged rollouts — start, finish and abandon a percentage traffic split
 * (GAPS.md A1 follow-on).
 *
 * Split out of `deployments.ts` as a self-contained sub-domain: nothing here
 * calls into the rest of that file and nothing there calls into this. The
 * consumer side was already separate — `src/dispatcher/rollout.ts` owns the
 * deterministic bucketing and `src/deploy/rollout-guard.ts` the sweep that aborts
 * a failing candidate — so this is the last piece of one feature living inside
 * another file's status machine.
 *
 * Deliberately NOT taken with it: `activate`, `rollback`, `pruneSuperseded` and
 * `cleanupExpiredPreviews`. Those mutate the same `DeploymentRow` status machine
 * through the shared phase-timestamp table, and `pruneSuperseded` exists to
 * collect exactly the rows `activate` supersedes — separating them would file
 * code rather than decompose it.
 *
 * The move changes the generated namespace (`api.deployments.setRollout` becomes
 * `api.rollouts.setRollout`), which is why every caller moves in the same change.
 */

interface DeploymentRow {
    _id: Id<"deployments">;
    kind: string;
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    scriptName: string;
    status: string;
}

interface ProjectRow {
    _id: Id<"projects">;
    activeDeploymentId?: Id<"deployments">;
    activeScriptName?: string;
    rollout?: { deploymentId: Id<"deployments">; percent: number; scriptName: string };
}

/** Percentages a rollout may sit at. Bounded so a typo cannot route 5000% of traffic anywhere. */
const MIN_ROLLOUT_PERCENT = 1;
const MAX_ROLLOUT_PERCENT = 99;

/**
 * Start or adjust a staged rollout: serve `percent` of traffic to a candidate
 * release while the active one keeps the rest (GAPS.md A1 follow-on).
 *
 * Blue/green promotes all at once. A rollout is the same pointer swap performed
 * gradually, so a regression is found by a fraction of users rather than
 * everyone — and because the metering stream already records outcome per script,
 * comparing the candidate's error rate against the active one is a read rather
 * than new instrumentation.
 *
 * Capped at 99: reaching 100 is {@link promoteRollout}'s job, which also swaps
 * the pointer and clears the rollout. Letting `percent` reach 100 would leave a
 * project serving entirely from a candidate that is still not its active
 * deployment — indistinguishable from promoted, but reverted by a single
 * `abortRollout` nobody expected to be destructive.
 *
 * Owners/admins only, and audited: this shifts live traffic.
 */
export const setRollout = mutation
    .use(rateLimit("machine"))
    .input({
        id: v.id("deployments"),
        organizationId: v.id("organizations"),
        percent: v.number(),
    })
    .mutation(async ({ ctx: context, args: { id, organizationId, percent } }): Promise<{ percent: number }> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);
        const deployment = (await context.db.get(id)) as DeploymentRow | null;

        if (deployment?.organizationId !== organizationId) {
            throw new LunoraError("NOT_FOUND", "deployment not found");
        }

        if (deployment.status !== "live") {
            throw new LunoraError("CONFLICT", `cannot roll out a ${deployment.status} deployment`);
        }

        const project = (await context.db.get(deployment.projectId)) as null | ProjectRow;

        if (project?.activeDeploymentId === id) {
            throw new LunoraError("CONFLICT", "this deployment is already the active release");
        }

        // The candidate must be the same KIND as the release it splits traffic with.
        // A preview carries a TTL and is destroyed by the cleanup sweep, so pointing
        // production traffic at one would strand that share on a deployment already
        // scheduled for deletion — and `promoteRollout` supersedes only same-kind
        // siblings, so promoting it would leave the real production release live
        // alongside a preview holding the pointer.
        const activeKind = project?.activeDeploymentId ? ((await context.db.get(project.activeDeploymentId)) as DeploymentRow | null)?.kind : undefined;

        if (activeKind !== undefined && deployment.kind !== activeKind) {
            throw new LunoraError("CONFLICT", `cannot roll out a ${deployment.kind} deployment against a ${activeKind} release`);
        }

        const rounded = Math.round(percent);

        if (!Number.isFinite(rounded) || rounded < MIN_ROLLOUT_PERCENT || rounded > MAX_ROLLOUT_PERCENT) {
            throw new LunoraError("BAD_REQUEST", `rollout percent must be between ${String(MIN_ROLLOUT_PERCENT)} and ${String(MAX_ROLLOUT_PERCENT)}`);
        }

        await context.db.patch(deployment.projectId, { rollout: { deploymentId: id, percent: rounded, scriptName: deployment.scriptName } });
        await context.db.insert("auditLog", {
            action: "deployment.rollout.set",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId,
            target: `${deployment.scriptName}@${String(rounded)}%`,
        });

        return { percent: rounded };
    });

/**
 * Finish a rollout: the candidate becomes the active release and the rollout is
 * cleared.
 *
 * Supersedes the previously-live releases exactly as {@link activate} does. That
 * duplication is deliberate — the alternative is a shared helper called by both a
 * machine-authorized deploy path and a member-authorized promote path with
 * different authorization already applied, which is the shape that makes an auth
 * check easy to lose.
 */
export const promoteRollout = mutation
    .use(rateLimit("machine"))
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .mutation(async ({ ctx: context, args: { organizationId, projectId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, projectId, organizationId, "project");

        const project = (await context.db.get(projectId)) as null | ProjectRow;

        if (!project?.rollout) {
            throw new LunoraError("CONFLICT", "no rollout in progress");
        }

        const candidateId = project.rollout.deploymentId;
        const candidate = (await context.db.get(candidateId)) as DeploymentRow | null;

        if (!candidate) {
            throw new LunoraError("NOT_FOUND", "the rollout candidate no longer exists");
        }

        // Re-checked at promote time, not only at `setRollout`. A rollout stays open
        // for as long as an operator leaves it, and in that window the candidate can
        // be superseded by another deploy or destroyed by a sweep — promoting then
        // would point the project's stable URL at a dead script.
        if (candidate.status !== "live") {
            throw new LunoraError("CONFLICT", `the rollout candidate is ${candidate.status} — start a new rollout rather than promoting this one`);
        }

        const { now } = context;
        const { page } = await context.db.deployments.findMany({ where: { projectId } }); // secret-scanner:allow -- domain field name
        const others = page.filter((row) => row._id !== candidateId && row.kind === candidate.kind && row.status === "live");

        for (const other of others) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(other._id, { status: "superseded", supersededAt: now, updatedAt: now });
        }

        await context.db.patch(projectId, {
            activeDeploymentId: candidateId,
            activeScriptName: candidate.scriptName,
            rollout: null,
        });
        await context.db.insert("auditLog", {
            action: "deployment.rollout.promote",
            actorUserId: member.userId,
            createdAt: now,
            organizationId,
            target: candidate.scriptName,
        });
    });

/**
 * Abandon a rollout: all traffic returns to the active release.
 *
 * The candidate is left `live` rather than superseded — it is a deployment that
 * still exists and may be rolled out again after a fix, and superseding it here
 * would make "we aborted the canary" indistinguishable from "we replaced it".
 */
export const abortRollout = mutation
    .use(rateLimit("machine"))
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .mutation(async ({ ctx: context, args: { organizationId, projectId } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, projectId, organizationId, "project");

        const project = (await context.db.get(projectId)) as null | ProjectRow;

        if (!project?.rollout) {
            throw new LunoraError("CONFLICT", "no rollout in progress");
        }

        await context.db.patch(projectId, { rollout: null });
        await context.db.insert("auditLog", {
            action: "deployment.rollout.abort",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId,
            target: project.rollout.scriptName,
        });
    });
