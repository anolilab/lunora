import { LunoraError } from "@lunora/server";

import type { Doc as Document_, Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";

type AliasOwnershipRow = Document_<"aliasOwnership">;

/**
 * Claim a deployment alias for a project through the `aliasOwnership` ledger.
 * The ledger's `by_alias` unique index makes the claim atomic, so this closes
 * the check-then-insert TOCTOU in `deployments.create`: a concurrent first claim of
 * the same new alias by a *different* project loses on the unique constraint and
 * is rejected. Idempotent for the owning project (re-deploys reuse their alias).
 */
export const claimAlias = async (context: MutationContext, alias: string, organizationId: Id<"organizations">, projectId: Id<"projects">): Promise<void> => {
    const currentOwner = async (): Promise<AliasOwnershipRow | undefined> => {
        const { page } = await context.db.aliasOwnership.findMany({ where: { alias } });

        return page[0];
    };

    const existing = await currentOwner();

    if (existing) {
        if (existing.projectId !== projectId) {
            throw new LunoraError("FORBIDDEN", "deployment alias is already in use by another project");
        }

        return;
    }

    try {
        await context.db.insert("aliasOwnership", { alias, createdAt: context.now, organizationId, projectId });
    } catch (error) {
        // Lost a concurrent first-claim race — the `by_alias` unique index rejected
        // the insert. Re-read the winner: if it is us, the claim stands; if it is
        // another project, reject cleanly; otherwise the failure was not an
        // ownership collision, so surface it.
        const winner = await currentOwner();

        if (winner?.projectId === projectId) {
            return;
        }

        if (winner) {
            throw new LunoraError("FORBIDDEN", "deployment alias is already in use by another project");
        }

        throw error;
    }
};

/** Whether `error` is {@link claimAlias}'s refusal of an alias another project owns. */
const isAliasTaken = (error: unknown): boolean => error instanceof LunoraError && error.code === "FORBIDDEN";

/**
 * Claim the first of `candidates` no other project owns, for `projectId`, and
 * answer it — a new project's production alias (`src/deploy/production-alias.ts`).
 * @throws {LunoraError} `CONFLICT` when every candidate is taken.
 */
export const claimFirstFreeAlias = async (
    context: MutationContext,
    candidates: ReadonlyArray<string>,
    organizationId: Id<"organizations">,
    projectId: Id<"projects">,
): Promise<string> => {
    for (const alias of candidates) {
        try {
            // eslint-disable-next-line no-await-in-loop -- candidates are tried in order; the first free one wins
            await claimAlias(context, alias, organizationId, projectId);

            return alias;
        } catch (error) {
            if (!isAliasTaken(error)) {
                throw error;
            }
        }
    }

    throw new LunoraError("CONFLICT", "every production alias tried for this project is taken; create it with another slug");
};

/**
 * Claim a deployment's alias for `project` ({@link claimAlias}). A refusal names the alias the
 * project reserved when it was created, so a CLI deploy whose wrangler `name`
 * someone else owns says what to deploy as instead.
 */
export const claimDeploymentAlias = async (
    context: MutationContext,
    alias: string,
    organizationId: Id<"organizations">,
    project: { _id: Id<"projects">; productionAlias?: null | string },
): Promise<void> => {
    try {
        await claimAlias(context, alias, organizationId, project._id);
    } catch (error) {
        const reserved = project.productionAlias;

        if (isAliasTaken(error) && reserved != null && reserved !== alias) {
            throw new LunoraError(
                "FORBIDDEN",
                `deployment alias "${alias}" is already in use by another project; this project's production alias is "${reserved}" — deploy as it: lunora cloud deploy --name ${reserved}`,
            );
        }

        throw error;
    }
};

/**
 * The deployments of a set the teardown sweep (`src/deploy/teardown.ts`) has
 * not finished with — what keeps a project on its target and a connected
 * account connected, because the tenant they name may still live there.
 *
 * The sweep acts on `destroyed` and `failed` rows whose `teardownAt` is unset,
 * and stamps `teardownAt` once it reclaimed them; it never revisits a stamped
 * row. So a row is pending while it is anything else (`live`, `queued`,
 * `superseded`, …: its tenant is running or about to), or while it is
 * `destroyed`/`failed` and not stamped yet. A stamped `failed` row is done —
 * the sweep reclaims only its stored release — and counting it would block a
 * target change or a disconnect forever, with nothing left that could unblock it.
 * `!= null`: `.global()` rows answer SQL NULL for an unset column.
 */
export const pendingTeardown = <Row extends { status: string; teardownAt?: null | number }>(rows: ReadonlyArray<Row>): Row[] =>
    rows.filter((row) => (row.status !== "destroyed" && row.status !== "failed") || row.teardownAt == null);

/**
 * Drop the alias claims of a project or organization being deleted whose
 * tenant is already gone, and keep the rest.
 *
 * An alias names its tenant — its script and the resources derived from it —
 * so it must stay claimed until the teardown sweep has destroyed that tenant:
 * released earlier, another project could claim the same alias and its first
 * deploy would converge onto the deleted project's tenant, data included,
 * while the sweep (seeing the alias alive again) never destroyed it. An alias
 * with a deployment the sweep has not finished with ({@link pendingTeardown})
 * is therefore left claimed, and the sweep releases it once the tenant is gone;
 * one with none (reserved and never deployed, or already torn down) is released
 * here, since no sweep will ever reach it.
 */
export const releaseIdleAliases = async (
    context: MutationContext,
    where: { organizationId: Id<"organizations"> } | { projectId: Id<"projects"> },
): Promise<void> => {
    const { page: deployments } = await context.db.deployments.findMany({ where });
    const claimed = new Set(pendingTeardown(deployments).map((row) => row.alias ?? row.scriptName));
    const { page: owned } = await context.db.aliasOwnership.findMany({ where });

    for (const row of owned) {
        if (!claimed.has(row.alias)) {
            // eslint-disable-next-line no-await-in-loop -- one scope's aliases are few
            await context.db.delete(row._id);
        }
    }
};
