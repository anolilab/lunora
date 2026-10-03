import { query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

/**
 * First-run onboarding checklist (GAPS.md ring 3 #5).
 *
 * **Derived, never stored.** Every step is computed from the org's real rows, so
 * there is no completion flag to get out of sync with the thing it claims — an
 * org that deletes its only project correctly goes back to step one, and nothing
 * has to remember to un-tick a box. It also means the checklist is honest for
 * orgs that existed before it did: they simply arrive complete.
 *
 * The steps are ordered by dependency, not preference — you cannot deploy without
 * a key, and nothing is live until something deployed — so the first incomplete
 * step is always the one to do next.
 */

/** How many rows each existence check scans. A checklist only needs to know "any". */
const PROBE_LIMIT = 1;

/** Scan enough deployments to find a live one without paging the whole history. */
const DEPLOYMENT_PROBE_LIMIT = 50;

/** One step of the checklist. */
interface ChecklistStep {
    done: boolean;
    /** Stable id, so the UI can key and label without matching on prose. */
    id: "deploy" | "key" | "live" | "project";
}

/** The checklist plus whether the whole thing is finished (so the UI can hide itself). */
interface ChecklistView {
    complete: boolean;
    steps: ChecklistStep[];
}

/** What the derivation needs from the org's rows — everything else is irrelevant to it. */
interface ChecklistInput {
    deployments: { status: string }[];
    keys: { revokedAt?: number }[];
    projects: number;
}

/**
 * Decide each step's state from the org's rows. Pure, so the rules that pick what
 * a user is told to do next are directly testable without a database.
 */
export const deriveChecklistSteps = (input: ChecklistInput): ChecklistStep[] => [
    { done: input.projects > 0, id: "project" },
    // A revoked key does not count — the step means "you can deploy", and a revoked
    // key cannot, so ticking it would send someone to a CI run that fails auth while
    // the checklist claims they are set.
    { done: input.keys.some((row) => row.revokedAt == null), id: "key" },
    // Deployed and live are separate facts: a failed deployment still proves the
    // pipeline ran, but nothing is serving yet.
    { done: input.deployments.length > 0, id: "deploy" },
    { done: input.deployments.some((row) => row.status === "live"), id: "live" },
];

/**
 * The org's onboarding progress: create a project → issue a deploy key → deploy →
 * see it live. Members only.
 */
export const checklist = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<ChecklistView> => {
        await assertMember(context, organizationId);

        const [projects, keys, deployments] = await Promise.all([
            context.db.projects.findMany({ limit: PROBE_LIMIT, where: { organizationId } }),
            context.db.deployKeys.findMany({ limit: DEPLOYMENT_PROBE_LIMIT, where: { organizationId } }),
            context.db.deployments.findMany({ limit: DEPLOYMENT_PROBE_LIMIT, orderBy: [{ createdAt: "desc" }], where: { organizationId } }),
        ]);

        const steps = deriveChecklistSteps({
            deployments: deployments.page,
            keys: keys.page,
            projects: projects.page.length,
        });

        return { complete: steps.every((step) => step.done), steps };
    });
