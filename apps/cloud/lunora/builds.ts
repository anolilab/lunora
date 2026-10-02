import { LunoraError } from "@lunora/server";

import type { PushChanges } from "../src/builds/paths";
import { decideBuild, MAX_CHANGED_FILES } from "../src/builds/paths";
import type { BuildReleaseTarget } from "../src/builds/release";
import { isUnconfiguredInfrastructure } from "../src/builds/runner";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, query, v } from "./_generated/server.js";
import { fireDeployAlerts } from "./alerts";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Server-side builds (GAPS.md A3/A4). A verified GitHub push records a build
 * via {@link recordPush}; the runner claims work with {@link claimNext}
 * (leased, stale-recoverable), streams output through {@link appendLog}, and
 * finishes with {@link complete} / {@link fail}. A successful build for the
 * same (project, commitSha) is reused instead of rebuilt (Zeitwork's
 * commit-addressed dedup).
 */

type BuildStatus = "building" | "failed" | "pending" | "skipped" | "successful";

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
    rootDirectory?: string;
    skipReason?: string;
    status: BuildStatus;
    trigger?: BuildTrigger;
}

interface ProjectRow {
    _id: Id<"projects">;
    activeScriptName?: string;
    githubRepo?: string;
    organizationId: Id<"organizations">;
    slug: string;
}

/** What recorded a build: a default-branch push (production) or a pull request (preview). */
type BuildTrigger = "pull_request" | "push";

/**
 * The push's changed files as the webhook parsed them. `files` is deliberately
 * unbounded per entry: a path over some cap failing validation would 500 the
 * webhook and drop the deploy, the one outcome the path filter must never have.
 * The list's length is bounded in the handler instead, by degrading to `unknown`.
 */
const pushChangesValidator = v.union(v.object({ files: v.array(v.string()) }), v.object({ unknown: v.string() }));

type RecordPushResult = null | { buildId: Id<"builds">; reused: boolean; skipped?: string };

type ClaimResult = null | { buildId: Id<"builds">; commitSha: string; projectId: Id<"projects">; rootDirectory?: string };

/** A lease older than this is stale — the runner died; the build is reclaimable. */
export const LEASE_STALE_MS = 30 * 60 * 1000;

/**
 * Record a build for a push to a connected repository (GAPS.md A4). Resolves
 * the project from the repository name itself — callers cannot aim it at an
 * arbitrary project. Reached via the HMAC-verified webhook edge route; the
 * only spoofable input is build volume, which the per-IP limiter caps.
 * Dedup: an existing successful build for (project, commitSha, rootDirectory,
 * trigger) is returned as-is (`reused: true`) instead of queuing a rebuild. The
 * trigger is part of the key because it decides the release: a pull request's
 * preview build must not swallow the production release of the same commit
 * once it is merged fast-forward.
 *
 * Path filter: a push whose changed files match none of the project's watch
 * paths is recorded as a `skipped` build carrying the reason, so the Builds tab
 * says why nothing deployed instead of showing nothing. A push that cannot
 * prove its changed files builds (see `decideBuild`).
 */
export const recordPush = internalMutation
    .use(rateLimit("machine"))
    .input({
        branch: boundedString(LIMITS.gitRef),
        changes: pushChangesValidator,
        commitSha: boundedString(LIMITS.id),
        installationId: v.number(),
        repository: boundedString(LIMITS.token),
        trigger: v.union(v.literal("push"), v.literal("pull_request")),
    })
    .mutation(async ({ ctx: context, args: { branch, changes, commitSha, installationId, repository, trigger } }): Promise<RecordPushResult> => {
        const { page } = await context.db.projects.findMany({ where: { githubRepo: repository } });
        const project = page[0];

        if (!project) {
            return null;
        }

        // Only pushes from an installation the project's org has *claimed*
        // build (staged-claim model, github-installations.ts). A spoofed RPC
        // call must present a valid (org, installation) pair.
        const { page: installationPage } = await context.db.githubInstallations.findMany({ where: { installationId } });
        const installation = installationPage[0];

        if (installation?.organizationId !== project.organizationId) {
            return null;
        }

        const { rootDirectory, watchPaths } = project;
        const { page: existingPage } = await context.db.builds.findMany({ where: { commitSha, projectId: project._id } }); // secret-scanner:allow -- domain field name
        const successful = existingPage.find(
            (build) => build.status === "successful" && build.bundleHash && build.rootDirectory === rootDirectory && build.trigger === trigger,
        );

        if (successful) {
            return { buildId: successful._id, reused: true };
        }

        const { now } = context;
        const bounded: PushChanges =
            "files" in changes && changes.files.length > MAX_CHANGED_FILES
                ? { unknown: `the push changed more than ${String(MAX_CHANGED_FILES)} files` }
                : changes;
        const decision = decideBuild(bounded, rootDirectory, watchPaths);
        const common = {
            branch,
            commitSha,
            createdAt: now,
            organizationId: project.organizationId,
            projectId: project._id, // secret-scanner:allow -- domain field name
            ...(rootDirectory === undefined ? {} : { rootDirectory }),
            trigger,
            updatedAt: now,
        };

        if (!decision.build) {
            const buildId = await context.db.insert("builds", { ...common, skipReason: decision.reason, status: "skipped" });

            return { buildId, reused: false, skipped: decision.reason };
        }

        // Backpressure: cap unfinished builds per project so a webhook storm
        // (or spoofed spam) can't flood the queue.
        const { page: projectBuilds } = await context.db.builds.findMany({ where: { projectId: project._id } }); // secret-scanner:allow -- domain field name
        const inFlight = projectBuilds.filter((build) => build.status === "pending" || build.status === "building").length;

        if (inFlight >= 5) {
            throw new LunoraError("TOO_MANY_REQUESTS", "too many unfinished builds for this project");
        }

        const buildId = await context.db.insert("builds", { ...common, status: "pending" });

        // The first line of the build's log says why it ran, so a build that a
        // monorepo filter should have skipped is diagnosable from the log alone.
        await context.db.insert("buildLogs", {
            buildId,
            createdAt: now,
            level: "info",
            line: `path filter: ${decision.reason}`,
            organizationId: project.organizationId,
        });

        return { buildId, reused: false };
    });

/**
 * Rows scanned per status when looking for claimable work.
 *
 * Small because both reads are ordered oldest-first and only the head is taken —
 * the bound exists to cap the read, not to sample.
 */
const CLAIM_SCAN = 50;

/**
 * Claim the next runnable build under a lease (GAPS.md A3). Picks the oldest
 * `pending` build — or a `building` one whose lease went stale (dead runner) —
 * and stamps the runner id + lease start. SYSTEM only (cron dispatch).
 */
export const claimNext = internalMutation.input({ runnerId: v.string() }).mutation(async ({ ctx: context, args: { runnerId } }): Promise<ClaimResult> => {
    const { now } = context;

    // Two bounded, status-scoped reads rather than one page of EVERY build.
    // `findMany({})` returned an arbitrary 1000-row slice across all statuses
    // and filtered afterwards, so on any real fleet the page filled with
    // finished builds and a queued one was simply never claimed — the queue
    // stalled while the sweep reported success, and `expireStale` failed the
    // build 24 hours later with no explanation.
    const [pendingPage, buildingPage] = await Promise.all([
        context.db.builds.findMany({ limit: CLAIM_SCAN, orderBy: [{ createdAt: "asc" }], where: { status: "pending" } }),
        context.db.builds.findMany({ limit: CLAIM_SCAN, orderBy: [{ createdAt: "asc" }], where: { status: "building" } }),
    ]);

    // A `building` row is claimable only once its lease has gone stale — that is
    // how a dead runner's work is recovered.
    const stale = buildingPage.page.filter((build) => build.processingStartedAt != null && now - build.processingStartedAt > LEASE_STALE_MS);
    const claimable = [...pendingPage.page, ...stale].toSorted((a, b) => a.createdAt - b.createdAt);
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

    return {
        buildId: next._id,
        commitSha: next.commitSha,
        projectId: next.projectId, // secret-scanner:allow -- domain field name
        ...(next.rootDirectory === undefined ? {} : { rootDirectory: next.rootDirectory }),
    };
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
            processingBy: null,
            processingStartedAt: null,
            status: "successful",
            successfulAt: now,
            updatedAt: now,
        });
    });

/**
 * Mark a claimed build failed with its error, and notify the org's `deploy` rules.
 *
 * The notification is raised in the same mutation as the status write. A build
 * that fails is the one moment in the release path where nobody is watching by
 * construction — it happens minutes after a push, on a cron, with the person who
 * pushed already doing something else — so recording the failure and telling
 * somebody about it have to be one outcome. Delivery itself is the drain sweep's
 * job (a mutation has no `fetch`).
 *
 * SYSTEM only.
 */
export const fail = internalMutation
    .input({ buildId: v.id("builds"), error: v.string(), runnerId: v.string() })
    .mutation(async ({ ctx: context, args: { buildId, error, runnerId } }): Promise<void> => {
        const build = assertLease(await context.db.get(buildId), runnerId);

        const { now } = context;

        await context.db.patch(buildId, {
            error,
            failedAt: now,
            processingBy: null,
            processingStartedAt: null,
            status: "failed",
            updatedAt: now,
        });

        // Not raised for the platform's own missing infrastructure — see
        // `isUnconfiguredInfrastructure`. The build is recorded failed either way;
        // this only decides whether a human is woken for it.
        if (isUnconfiguredInfrastructure(error)) {
            return;
        }

        const project = (await context.db.get(build.projectId)) as null | { name: string };

        await fireDeployAlerts(context, build.organizationId, `build:${buildId}`, {
            detail: error,
            kind: "build",
            project: project?.name ?? "project",
            reference: `${build.branch}@${build.commitSha.slice(0, 7)}`,
        });
    });

/**
 * Everything needed to write a commit status for one build: the repository, the
 * commit, and the installation that grants write access to it.
 *
 * Resolved here rather than stored on the build row, because both halves already
 * have an owner and neither belongs to a build: the repository is the project's
 * connection (`githubRepo`), and the installation is the org's claim. Copying
 * them onto every build would give a rename or a re-install two places to be
 * right, and the second one is the one nobody updates.
 *
 * Returns `null` when either is missing — a project with no connected repo, or an
 * org that has not claimed an installation — which is the ordinary state for a
 * build that arrived any way other than a push. SYSTEM only.
 */
export const reportTarget = internalQuery
    .input({ buildId: v.id("builds") })
    .query(async ({ ctx: context, args: { buildId } }): Promise<null | { commitSha: string; installationId: number; repository: string }> => {
        const build = (await context.db.get(buildId)) as BuildRow | null;

        if (!build) {
            return null;
        }

        const project = (await context.db.get(build.projectId)) as null | ProjectRow;

        if (!project?.githubRepo) {
            return null;
        }

        const { page } = await context.db.githubInstallations.findMany({ where: { organizationId: build.organizationId } });
        const installation = page.find((row) => row.claimedAt !== undefined);

        if (!installation) {
            return null;
        }

        return { commitSha: build.commitSha, installationId: installation.installationId, repository: project.githubRepo };
    });

/**
 * What releasing a build needs beyond its claim: the project it belongs to, the
 * alias that project already deploys to, and what recorded the build — which is
 * what decides production versus preview (`src/builds/release.ts`).
 *
 * Read from the rows, never from the caller: the release is aimed by the build
 * the webhook recorded, not by anything the build box reported. SYSTEM only.
 */
export const releaseTarget = internalQuery
    .input({ buildId: v.id("builds") })
    .query(async ({ ctx: context, args: { buildId } }): Promise<BuildReleaseTarget | null> => {
        const build = (await context.db.get(buildId)) as BuildRow | null;

        if (!build) {
            return null;
        }

        const project = (await context.db.get(build.projectId)) as null | ProjectRow;

        if (project?.organizationId !== build.organizationId) {
            return null;
        }

        return {
            ...(project.activeScriptName === undefined ? {} : { activeScriptName: project.activeScriptName }),
            branch: build.branch,
            organizationId: build.organizationId,
            projectId: build.projectId, // secret-scanner:allow -- domain field name
            projectSlug: project.slug,
            ...(build.trigger === undefined ? {} : { trigger: build.trigger }),
        };
    });

/** A project's builds, newest first (members). */
export const listByProject = query
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(async ({ ctx: context, args: { organizationId, projectId } }): Promise<BuildRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.builds.findMany({ where: { organizationId, projectId } }); // secret-scanner:allow -- domain field name

        return page.toSorted((a, b) => b.createdAt - a.createdAt);
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

            return page.filter((row) => row.createdAt > cursor).toSorted((a, b) => a.createdAt - b.createdAt);
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
    const stale = page.filter(
        (build) =>
            (build.status === "pending" && now - build.createdAt > PENDING_EXPIRY_MS) ||
            (build.status === "building" && build.processingStartedAt != null && now - build.processingStartedAt > 4 * LEASE_STALE_MS),
    );

    for (const build of stale) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
        await context.db.patch(build._id, {
            error: build.status === "pending" ? "no build runner picked this up within 24h" : "build lease expired without completion",
            failedAt: now,
            processingBy: null,
            processingStartedAt: null,
            status: "failed",
            updatedAt: now,
        });
    }

    return { expired: stale.length };
});
