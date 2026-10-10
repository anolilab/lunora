import { LunoraError } from "@lunora/server";

import { mutation, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";

/**
 * Staged rollouts — refused on Lunora Cloud (GAPS.md A1 follow-on).
 *
 * A rollout serves a candidate release to a share of traffic while the active
 * one serves the rest, which needs two Workers live at once. A Lunora app keeps
 * its data in Durable Objects, and a Durable Object namespace belongs to the
 * script that defines its class — so a second script is a second, empty
 * database, and a split between two scripts splits the app's DATA, not just its
 * traffic. The only way out is a canary Worker whose Durable Object bindings
 * point at the stable Worker's classes (`script_name`), and neither Cloudflare's
 * Workers for Platforms docs nor Alchemy's dispatch-namespace path establish
 * that a user Worker can bind another user Worker's class. Workers for
 * Platforms also has no gradual deployments for user Workers. Until one of those
 * exists, every release goes out to 100% of traffic on the project's one Worker.
 *
 * The three mutations stay so a caller gets this explanation rather than a
 * missing-function error, and they are authorized first so the refusal leaks
 * nothing to a non-member.
 */
const ROLLOUTS_UNSUPPORTED = "staged rollouts are not supported on Workers for Platforms: a canary cannot share the project's Durable Object data";

const refuse = (): never => {
    throw new LunoraError("BAD_REQUEST", ROLLOUTS_UNSUPPORTED);
};

/** Start or adjust a staged rollout. Always refused — see the module note. */
export const setRollout = mutation
    .use(rateLimit("machine"))
    .input({ id: v.id("deployments"), organizationId: v.id("organizations"), percent: v.number() })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<never> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        return refuse();
    });

/** Finish a staged rollout. No rollout can be started, so there is never one to promote. */
export const promoteRollout = mutation
    .use(rateLimit("machine"))
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<never> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        return refuse();
    });

/** Abandon a staged rollout. No rollout can be started, so there is never one to abort. */
export const abortRollout = mutation
    .use(rateLimit("machine"))
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .mutation(async ({ ctx: context, args: { organizationId } }): Promise<never> => {
        await assertMember(context, organizationId, ["owner", "admin"]);

        return refuse();
    });
