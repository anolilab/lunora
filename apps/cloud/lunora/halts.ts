import { LunoraError } from "@lunora/server";

import type { ControlPlaneStore } from "../src/d1-store";
import type { HaltRequestResult, HaltRow } from "../src/deploy/halt";
import {
    BOX_HALT_REFUSAL,
    canHalt,
    HALT_ON_SUSPENSION_REASONS,
    HALTED_REFUSAL,
    haltsOnSuspension,
    liveByAlias,
    requestOrganizationHalt,
    requestOrganizationResume,
    SUPPORT_ACTOR,
} from "../src/deploy/halt";
import { beginConverge as beginConvergeOnStore, endConverge as endConvergeOnStore } from "../src/deploy/worker-classes";
import { storedTarget } from "../src/provision-contract";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "./_generated/server.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { collectAll } from "./paginate";

/**
 * Emergency stop (`src/deploy/halt.ts`): what the studio shows and asks for,
 * the operator's support path, and the check every deploy, rollback and
 * release of a halted project is refused by.
 *
 * The mutations write intent only — a `halts` row per alias. The every-minute
 * halt sweep converges each alias's Worker onto its stub, or back onto its
 * release, within a minute or two; the studio shows each row's progress.
 */

/**
 * The function's `ctx.db` as the structural store the shared halt logic is
 * written against — the same logic the scheduled sweep runs over D1.
 */
const storeOf = (database: MutationContext["db"]): ControlPlaneStore => {
    const generic = database as unknown as Record<
        string,
        { findMany: (args: unknown) => Promise<{ continueCursor?: null | string; isDone?: boolean; page: unknown[] }> }
    > & {
        delete: (id: string) => Promise<unknown>;
        get: (id: string) => Promise<unknown>;
        insert: (table: string, document: Record<string, unknown>) => Promise<unknown>;
        patch: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
    };

    return {
        delete: async (id: string) => generic.delete(id),
        findMany: async (table: string, args?: unknown) => {
            const facade = generic[table] as (typeof generic)[string] | undefined;

            if (facade === undefined) {
                throw new Error(`no table ${table}`);
            }

            return facade.findMany(args);
        },
        get: async (id: string) => generic.get(id),
        insert: async (table: string, document: Record<string, unknown>) => generic.insert(table, document),
        patch: async (id: string, patch: Record<string, unknown>) => generic.patch(id, patch),
    };
};

/**
 * Whether a project is halted — the condition every deploy, rollback and
 * release of it is refused under: it has a `halts` row, or support holds its
 * whole organization (which also covers an alias that has no live release yet).
 */
export const projectHalted = async (context: QueryContext, projectId: Id<"projects">): Promise<boolean> => {
    const { page } = await context.db.halts.findMany({ limit: 1, where: { projectId } });

    if (page.length > 0) {
        return true;
    }

    const project = await context.db.projects.get(projectId);
    const organization = project ? await context.db.organizations.get(project.organizationId) : null;

    return organization?.supportHaltedAt != null;
};

/** Refuse a deploy, rollback or release of a halted project. */
export const assertProjectNotHalted = async (context: QueryContext, projectId: Id<"projects">): Promise<void> => {
    if (await projectHalted(context, projectId)) {
        throw new LunoraError("CONFLICT", HALTED_REFUSAL);
    }
};

/** One halted alias, as the studio shows it. */
export interface HaltView {
    alias: string;
    attempts: number;
    haltedAt?: number;
    haltedBy: string;
    kind: string;
    lastError?: string;
    projectId: string;
    reason: string;
    requestedAt: number;
    source: "manual" | "support" | "suspension";
    state: "halted" | "halting" | "resuming";
}

/** What the studio's emergency-stop card shows. */
export interface HaltStatus {
    /** Whether the current suspension halts the projects (and a resume is refused until it lifts). */
    autoHalted: boolean;
    /** Live aliases a halt would reach that are not halted yet. */
    haltable: number;
    /** The organization's setting: absent means on. */
    haltOnSuspension: boolean;
    halts: HaltView[];
    /** Support holds the organization: only support lifts it. */
    supportHalted: boolean;
    suspendedReason?: string;
    /** Live aliases a halt does not reach, with the reason. */
    unsupported: HaltRequestResult["unsupported"];
}

const toView = (row: HaltRow): HaltView => {
    return {
        alias: row.alias,
        attempts: row.attempts ?? 0,
        ...(row.haltedAt == null ? {} : { haltedAt: row.haltedAt }),
        haltedBy: row.haltedBy,
        kind: row.kind,
        ...(row.lastError == null ? {} : { lastError: row.lastError }),
        projectId: row.projectId,
        reason: row.reason,
        requestedAt: row.createdAt,
        source: row.source,
        state: row.state,
    };
};

/** The organization's halt state (any member). */
export const status = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<HaltStatus> => {
    const member = await assertMember(context, organizationId);
    const [organization, halts, deployments] = await Promise.all([
        context.db.organizations.get(member.organizationId),
        collectAll((cursor) => context.db.halts.findMany({ cursor, where: { organizationId: member.organizationId } })),
        collectAll((cursor) => context.db.deployments.findMany({ cursor, where: { organizationId: member.organizationId } })),
    ]);
    const live = [...liveByAlias(deployments as Parameters<typeof liveByAlias>[0])];
    const halted = new Set((halts as HaltRow[]).map((row) => row.alias));
    const unsupported = live
        .filter(([, row]) => storedTarget(row.target) === "celld-vps")
        .map(([alias]) => {
            return { alias, reason: BOX_HALT_REFUSAL };
        });
    const haltable = live.filter(([alias, row]) => {
        const target = storedTarget(row.target);

        return target !== undefined && canHalt(target) && !halted.has(alias);
    }).length;

    return {
        autoHalted: organization ? haltsOnSuspension(organization) : false,
        halts: (halts as HaltRow[]).map((row) => toView(row)).toSorted((a, b) => a.alias.localeCompare(b.alias)),
        haltable,
        haltOnSuspension: organization?.haltOnSuspension !== false,
        supportHalted: organization?.supportHaltedAt != null,
        ...(organization?.suspendedAt != null && organization.suspendedReason != null ? { suspendedReason: organization.suspendedReason } : {}),
        unsupported,
    };
});

/**
 * Refuse a resume the suspension would undo on the next tick: while a
 * suspension `haltOnSuspension` covers holds, the projects stay halted.
 */
const assertResumable = async (context: QueryContext, organizationId: Id<"organizations">): Promise<void> => {
    const organization = await context.db.organizations.get(organizationId);

    if (organization && haltsOnSuspension(organization)) {
        throw new LunoraError(
            "CONFLICT",
            `this organization is suspended (${String(organization.suspendedReason)}) and its projects stay halted until the suspension lifts — or turn off "halt on suspension" first`,
        );
    }
};

/**
 * Emergency stop (owners/admins): halt every live alias of the organization.
 * The Worker of each converges onto a stub within a minute or two; deploys,
 * rollbacks and git-build releases are refused until a resume. Audit-logged.
 */
export const haltOrganization = mutation
    .use(rateLimit("sensitive"))
    .input({ organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<HaltRequestResult> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        return requestOrganizationHalt(storeOf(context.db), {
            actor: member.userId,
            now: context.now,
            organizationId: member.organizationId,
            reason: "manual",
            source: "manual",
        });
    });

/**
 * Resume (owners/admins): converge every alias they or a suspension halted
 * back onto its live release. Refused while a covered suspension holds, and
 * while support holds the organization — support's stop is support's to lift.
 */
export const resumeOrganization = mutation
    .use(rateLimit("sensitive"))
    .input({ organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<{ resumed: string[] }> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);
        const organization = await context.db.organizations.get(member.organizationId);

        if (organization?.supportHaltedAt != null) {
            throw new LunoraError("FORBIDDEN", "Lunora support stopped this organization's projects; only support can resume them — contact support");
        }

        await assertResumable(context, member.organizationId);

        return requestOrganizationResume(storeOf(context.db), {
            actor: member.userId,
            now: context.now,
            organizationId: member.organizationId,
            sources: ["manual", "suspension"],
        });
    });

/**
 * Whether a `spend-cap` or `overage` suspension also halts the organization's
 * projects (owners only — it decides whether running code keeps billing past
 * the cap). Turning it off resumes the suspension's halts on the next tick.
 * Audit-logged.
 */
export const setHaltOnSuspension = mutation
    .use(rateLimit("sensitive"))
    .input({ enabled: v.boolean(), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { enabled, organizationId } }): Promise<null> => {
        const member = await assertMember(context, organizationId, ["owner"]);

        await context.db.organizations.patch(member.organizationId, { haltOnSuspension: enabled });
        await context.db.insert("auditLog", {
            action: "halt.on_suspension",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId: member.organizationId,
            target: `${enabled ? "on" : "off"} (${[...HALT_ON_SUSPENSION_REASONS].join(", ")})`,
        });

        return null;
    });

/** Support's "resume this alias onto release X": the release must be the organization's, live or retained, and its alias halted. */
const resumeOnto = async (
    context: MutationContext,
    input: { deploymentId: Id<"deployments">; organizationId: Id<"organizations"> },
): Promise<{ resumed: string[] }> => {
    const deployment = await context.db.deployments.get(input.deploymentId);

    if (deployment?.organizationId !== input.organizationId || (deployment.status !== "live" && deployment.status !== "superseded")) {
        throw new LunoraError("NOT_FOUND", "no live or retained release with that id in this organization");
    }

    const alias = deployment.alias ?? deployment.scriptName;
    const { page } = await context.db.halts.findMany({ limit: 1, where: { alias, projectId: deployment.projectId } });
    if (page.length === 0) {
        throw new LunoraError("CONFLICT", `${alias} is not halted`);
    }

    await context.db.patch((page[0] as { _id: Id<"halts"> })._id, {
        attempts: 0,
        lastError: null,
        nextAttemptAt: null,
        resumeDeploymentId: input.deploymentId,
        state: "resuming",
        updatedAt: context.now,
    });
    await context.db.insert("auditLog", {
        action: "halt.resume_requested",
        actorUserId: SUPPORT_ACTOR,
        createdAt: context.now,
        organizationId: input.organizationId,
        target: `${alias} onto release ${input.deploymentId}`,
    });

    return { resumed: [alias] };
};

/**
 * Support's emergency stop and resume (`POST /v1/halts`, admin-token gated).
 *
 * A support halt holds the whole organization (`organizations.supportHaltedAt`:
 * a deploy of an alias with no live release is refused too) and its rows are
 * `support` rows, which no owner or admin can lift and no suspension change
 * touches. A resume clears both, follows the same suspension rule an owner's
 * does, and with `deploymentId` resumes that one alias onto that release
 * instead of its live one — still refused unless it binds every class that
 * may be on the Worker.
 */
export const operatorHalt = internalMutation
    .input({ action: v.union(v.literal("halt"), v.literal("resume")), deploymentId: v.optional(v.id("deployments")), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { action, deploymentId, organizationId } }): Promise<HaltRequestResult | { resumed: string[] }> => {
        const organization = await context.db.organizations.get(organizationId);

        if (!organization) {
            throw new LunoraError("NOT_FOUND", "organization not found");
        }

        if (action === "halt") {
            await context.db.organizations.patch(organizationId, { supportHaltedAt: context.now });

            return requestOrganizationHalt(storeOf(context.db), {
                actor: SUPPORT_ACTOR,
                now: context.now,
                organizationId,
                reason: "support",
                source: "support",
            });
        }

        await assertResumable(context, organizationId);

        if (deploymentId !== undefined) {
            return resumeOnto(context, { deploymentId, organizationId });
        }

        await context.db.patch(organizationId, { supportHaltedAt: null });

        return requestOrganizationResume(storeOf(context.db), { actor: SUPPORT_ACTOR, now: context.now, organizationId });
    });

/** The class shape the converge record stores (`src/deploy/worker-classes.ts`). */
const boundClassInput = v.array(v.object({ binding: v.string(), className: v.string(), sqlite: v.optional(v.boolean()), type: v.string() }));

/**
 * Record a converge about to start on an alias's Worker (the deploy edge's
 * `recordingDriver`): its classes may be on the Worker from now on. The
 * converge is refused when this fails.
 */
export const beginConverge = internalMutation
    .input({ alias: v.string(), classes: boundClassInput, now: v.number(), token: v.string() })
    .mutation(async ({ ctx: context, args }): Promise<null> => {
        await beginConvergeOnStore(storeOf(context.db), args);

        return null;
    });

/** Record how a converge on an alias's Worker ended. */
export const endConverge = internalMutation
    .input({
        alias: v.string(),
        classes: boundClassInput,
        now: v.number(),
        outcome: v.union(v.literal("failed"), v.literal("not-uploaded"), v.literal("succeeded")),
        startedAt: v.number(),
        token: v.string(),
    })
    .mutation(async ({ ctx: context, args }): Promise<null> => {
        await endConvergeOnStore(storeOf(context.db), args);

        return null;
    });

/**
 * Whether an alias is halted — read by the deploy edge right before it
 * converges anything onto the alias's Worker (`src/deploy/routes/deploy.ts`),
 * so a deploy, revert or rollback already in flight when the halt was asked
 * for cannot land on top of the stub. Scoped to the alias's OWNER: a row a
 * previous owner left behind holds nothing of the project that claimed it since.
 */
export const aliasHalted = internalQuery.input({ alias: v.string() }).query(async ({ ctx: context, args: { alias } }): Promise<boolean> => {
    const { page: owners } = await context.db.aliasOwnership.findMany({ limit: 1, where: { alias } });

    return owners.length > 0 && projectHalted(context, (owners[0] as { projectId: Id<"projects"> }).projectId);
});
