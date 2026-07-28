import { LunoraError } from "@lunora/server";

import { runBuildDispatch } from "../src/builds/dispatch";
import type { BuildRunnerPorts } from "../src/builds/runner";
import type { Id } from "./_generated/dataModel.js";
import { internalAction, internalMutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/** The runner ports speak plain strings; the mutations want the branded id. */
type BuildId = Id<"builds">;

/**
 * Server-side builds (GAPS.md A3/A4). A verified GitHub push records a build
 * via {@link recordPush}; the runner claims work with {@link claimNext}
 * (leased, stale-recoverable), streams output through {@link appendLog}, and
 * finishes with {@link complete} / {@link fail}. A successful build for the
 * same (project, commitSha) is reused instead of rebuilt (Zeitwork's
 * commit-addressed dedup).
 */

type BuildStatus = "building" | "failed" | "pending" | "successful";

interface BuildRow {
    _id: Id<"builds">;
    branch: string;
    bundleHash?: string;
    commitSha: string;
    createdAt: number;
    organizationId: Id<"organizations">;
    processingBy?: string;
    processingStartedAt?: number;
    projectId: Id<"projects">;
    status: BuildStatus;
}

interface ProjectRow {
    _id: Id<"projects">;
    githubRepo?: string;
    organizationId: Id<"organizations">;
}

/** A lease older than this is stale — the runner died; the build is reclaimable. */
export const LEASE_STALE_MS = 30 * 60 * 1000;

/**
 * Record a build for a push to a connected repository (GAPS.md A4). Resolves
 * the project from the repository name itself — callers cannot aim it at an
 * arbitrary project. Reached via the HMAC-verified webhook edge route; the
 * only spoofable input is build volume, which the per-IP limiter caps.
 * Dedup: an existing successful build for (project, commitSha) is returned
 * as-is (`reused: true`) instead of queuing a rebuild.
 */
export const recordPush = internalMutation
    .use(rateLimit("machine"))
    .input({
        branch: boundedString(LIMITS.gitRef),
        commitSha: boundedString(LIMITS.id),
        installationId: v.number(),
        repository: boundedString(LIMITS.token),
    })
    .mutation(async ({ ctx: context, args: { branch, commitSha, installationId, repository } }): Promise<null | { buildId: Id<"builds">; reused: boolean }> => {
        const { page } = await context.db.projects.findMany({ where: { githubRepo: repository } });
        const project = (page as unknown as ProjectRow[])[0];

        if (!project) {
            return null;
        }

        // Only pushes from an installation the project's org has *claimed*
        // build (staged-claim model, github-installations.ts). A spoofed RPC
        // call must present a valid (org, installation) pair.
        const { page: installationPage } = await context.db.githubInstallations.findMany({ where: { installationId } });
        const installation = (installationPage as unknown as { organizationId?: Id<"organizations"> }[])[0];

        if (installation?.organizationId !== project.organizationId) {
            return null;
        }

        const { page: existingPage } = await context.db.builds.findMany({ where: { commitSha, projectId: project._id } }); // secret-scanner:allow -- domain field name
        const successful = (existingPage as unknown as BuildRow[]).find((build) => build.status === "successful" && build.bundleHash);

        if (successful) {
            return { buildId: successful._id, reused: true };
        }

        // Backpressure: cap unfinished builds per project so a webhook storm
        // (or spoofed spam) can't flood the queue.
        const { page: projectBuilds } = await context.db.builds.findMany({ where: { projectId: project._id } }); // secret-scanner:allow -- domain field name
        const inFlight = (projectBuilds as unknown as BuildRow[]).filter((build) => build.status === "pending" || build.status === "building").length;

        if (inFlight >= 5) {
            throw new LunoraError("TOO_MANY_REQUESTS", "too many unfinished builds for this project");
        }

        const { now } = context;
        const buildId = await context.db.insert("builds", {
            branch,
            commitSha,
            createdAt: now,
            organizationId: project.organizationId,
            projectId: project._id, // secret-scanner:allow -- domain field name
            status: "pending",
            updatedAt: now,
        });

        return { buildId, reused: false };
    });

/**
 * Claim the next runnable build under a lease (GAPS.md A3). Picks the oldest
 * `pending` build — or a `building` one whose lease went stale (dead runner) —
 * and stamps the runner id + lease start. SYSTEM only (cron dispatch).
 */
export const claimNext = internalMutation
    .input({ runnerId: v.string() })
    .mutation(async ({ ctx: context, args: { runnerId } }): Promise<null | { buildId: Id<"builds">; commitSha: string; projectId: Id<"projects"> }> => {
        const { now } = context;
        const { page } = await context.db.builds.findMany({});
        const claimable = (page as unknown as BuildRow[])
            .filter(
                (build) =>
                    build.status === "pending" ||
                    (build.status === "building" && build.processingStartedAt != null && now - build.processingStartedAt > LEASE_STALE_MS),
            )
            .toSorted((a, b) => a.createdAt - b.createdAt);
        const next = claimable[0];

        if (!next) {
            return null;
        }

        await context.db.patch(next._id, {
            buildingAt: now,
            processingBy: runnerId,
            processingStartedAt: now,
            status: "building",
            updatedAt: now,
        });

        return { buildId: next._id, commitSha: next.commitSha, projectId: next.projectId }; // secret-scanner:allow -- domain field name
    });

const assertLease = (build: BuildRow | null, runnerId: string): BuildRow => {
    if (!build) {
        throw new LunoraError("NOT_FOUND", "build not found");
    }

    if (build.processingBy !== runnerId) {
        throw new LunoraError("CONFLICT", "build lease is held by another runner");
    }

    return build;
};

/** Append one output line to a claimed build (runner-only, lease-checked). SYSTEM only. */
export const appendLog = internalMutation
    .input({ buildId: v.id("builds"), level: v.union(v.literal("info"), v.literal("error")), line: v.string(), runnerId: v.string() })
    .mutation(async ({ ctx: context, args: { buildId, level, line, runnerId } }): Promise<void> => {
        const build = assertLease(await context.db.get(buildId), runnerId);

        await context.db.insert("buildLogs", { buildId, createdAt: context.now, level, line, organizationId: build.organizationId });
    });

/** Mark a claimed build successful with its bundle hash. SYSTEM only. */
export const complete = internalMutation
    .input({ buildId: v.id("builds"), bundleHash: v.string(), deploymentId: v.optional(v.string()), runnerId: v.string() })
    .mutation(async ({ ctx: context, args: { buildId, bundleHash, deploymentId, runnerId } }): Promise<void> => {
        assertLease(await context.db.get(buildId), runnerId);

        const { now } = context;

        await context.db.patch(buildId, {
            bundleHash,
            ...(deploymentId === undefined ? {} : { deploymentId }),
            processingBy: undefined,
            processingStartedAt: undefined,
            status: "successful",
            successfulAt: now,
            updatedAt: now,
        });
    });

/** Mark a claimed build failed with its error. SYSTEM only. */
export const fail = internalMutation
    .input({ buildId: v.id("builds"), error: v.string(), runnerId: v.string() })
    .mutation(async ({ ctx: context, args: { buildId, error, runnerId } }): Promise<void> => {
        assertLease(await context.db.get(buildId), runnerId);

        const { now } = context;

        await context.db.patch(buildId, {
            error,
            failedAt: now,
            processingBy: undefined,
            processingStartedAt: undefined,
            status: "failed",
            updatedAt: now,
        });
    });

/** A project's builds, newest first (members). */
export const listByProject = query
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(async ({ ctx: context, args: { organizationId, projectId } }): Promise<BuildRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.builds.findMany({ where: { organizationId, projectId } }); // secret-scanner:allow -- domain field name

        return (page as unknown as BuildRow[]).toSorted((a, b) => b.createdAt - a.createdAt);
    });

/**
 * A build's output lines after `afterCreatedAt` (cursor pagination — the
 * dashboard tails by repeatedly passing the last timestamp it saw). Members.
 */
export const logs = query
    .input({ afterCreatedAt: v.optional(v.number()), buildId: v.id("builds"), organizationId: v.id("organizations") })
    .query(
        async ({
            ctx: context,
            args: { afterCreatedAt, buildId, organizationId },
        }): Promise<{ createdAt: number; level: "error" | "info"; line: string }[]> => {
            await assertMember(context, organizationId);

            const build = (await context.db.get(buildId)) as BuildRow | null;

            if (build?.organizationId !== organizationId) {
                throw new LunoraError("NOT_FOUND", "build not found in this organization");
            }

            const { page } = await context.db.buildLogs.findMany({ where: { buildId } });
            const cursor = afterCreatedAt ?? 0;

            return (page as unknown as { createdAt: number; level: "error" | "info"; line: string }[])
                .filter((row) => row.createdAt > cursor)
                .toSorted((a, b) => a.createdAt - b.createdAt);
        },
    );

/** A pending build older than this never got a runner — fail it visibly. */
export const PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Self-heal the build queue (GAPS.md A3 seam): fail pending builds nothing
 * ever claimed within 24h, and fail building rows whose lease has been stale
 * for over 2h (a claim-crash loop shouldn't pin the dashboard on "building"
 * forever — a fresh push can always re-queue). SYSTEM only (cron dispatch).
 */
export const expireStale = internalMutation.mutation(async ({ ctx: context }): Promise<{ expired: number }> => {
    const { now } = context;
    const { page } = await context.db.builds.findMany({});
    const stale = (page as unknown as BuildRow[]).filter(
        (build) =>
            (build.status === "pending" && now - build.createdAt > PENDING_EXPIRY_MS) ||
            (build.status === "building" && build.processingStartedAt != null && now - build.processingStartedAt > 4 * LEASE_STALE_MS),
    );

    for (const build of stale) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
        await context.db.patch(build._id, {
            error: build.status === "pending" ? "no build runner picked this up within 24h" : "build lease expired without completion",
            failedAt: now,
            processingBy: undefined,
            processingStartedAt: undefined,
            status: "failed",
            updatedAt: now,
        });
    }

    return { expired: stale.length };
});

/**
 * The build source/execute seam, resolved from configuration.
 *
 * Both ports are 🌐 and neither can be faked: `fetchSource` needs a GitHub App
 * installation token (an App id + private key — distinct from the
 * `GITHUB_CLIENT_ID`/`SECRET` OAuth pair used for social sign-in), and `execute`
 * needs a container to run `lunora build` in. Until those exist, this throws with
 * the reason, which `runBuild` turns into a logged, FAILED build.
 *
 * That failure is the point. Before the dispatcher was wired, a pushed build sat
 * `pending` with nobody to claim it and was failed 24 hours later by the expiry
 * cron, with no explanation anywhere. Failing in the first minute, with the cause
 * written to `buildLogs`, is strictly better than silence — and the day the
 * infrastructure lands, only this function changes.
 */
const unconfigured = (what: string) => (): never => {
    throw new LunoraError(
        "INTERNAL",
        `build ${what} is not configured: the control plane has no ${what === "source fetch" ? "GitHub App credentials (app id + private key) to mint an installation token" : "build container binding to execute `lunora build`"}. Builds cannot run until it is provisioned.`,
    );
};

/**
 * Claim and run queued builds — the loop that was missing.
 *
 * `builds.recordPush` enqueues, `claimNext` leases and `runBuild` drives a build
 * through fetch → execute → complete/fail, but nothing called the loop that joins
 * them, so `claimNext` had no caller in the entire codebase. This is that caller,
 * invoked once a minute by the cron in `lunora/crons.ts`.
 *
 * `runnerId` identifies this lease holder. It is derived from `ctx.now` rather
 * than randomly so a handler re-run under OCC retry reuses the same id instead of
 * orphaning the lease it just took.
 */
export const dispatch = internalAction.action(async ({ ctx: context }): Promise<{ ran: number }> => {
    const runnerId = `cron-${String(context.now)}`;

    const runnerPorts: BuildRunnerPorts = {
        appendLog: async (buildId, level, line) => {
            await context.runMutation(appendLog, { buildId: buildId as BuildId, level, line, runnerId });
        },
        complete: async (buildId, bundleHash) => {
            await context.runMutation(complete, { buildId: buildId as BuildId, bundleHash, runnerId });
        },
        execute: unconfigured("execution"),
        fail: async (buildId, error) => {
            await context.runMutation(fail, { buildId: buildId as BuildId, error, runnerId });
        },
        fetchSource: unconfigured("source fetch"),
    };

    const { outcomes } = await runBuildDispatch({
        claimNext: async (id) => (await context.runMutation(claimNext, { runnerId: id })),
        runnerId,
        runnerPorts,
    });

    return { ran: outcomes.length };
});
