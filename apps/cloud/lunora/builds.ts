import { LunoraError } from "@lunora/server";

import type { BuildDecision, PushChanges } from "../src/builds/paths";
import { decideBuild, MAX_CHANGED_FILES } from "../src/builds/paths";
import type { BuildReleaseTarget } from "../src/builds/release";
import { isUnconfiguredInfrastructure } from "../src/builds/runner";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
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
    deploymentId?: string;
    fromFork?: boolean;
    organizationId: Id<"organizations">;
    processingBy?: string;
    processingStartedAt?: number;
    projectId: Id<"projects">;
    pullRequest?: number;
    reusesBuildId?: Id<"builds">;
    rootDirectory?: string;
    skipReason?: string;
    status: BuildStatus;
    trigger?: BuildTrigger;
}

/**
 * Deployment states in which a release is serving or about to: a push of its
 * commit again (a redelivered webhook, say) has nothing left to do.
 */
const SERVING_STATUSES: ReadonlySet<string> = new Set(["building", "live", "provisioning", "queued", "verifying"]);

interface ProjectRow {
    _id: Id<"projects">;
    activeScriptName?: string;
    githubRepo?: string;
    organizationId: Id<"organizations">;
    productionAlias?: null | string;
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

type RecordPushResult = null | { buildId: Id<"builds">; reused: boolean; skipped?: string } | { duplicate: true };

/**
 * How long a webhook delivery id is remembered. GitHub lets a delivery be
 * redelivered for three days; a day on top covers a redelivery that is itself
 * retried.
 */
export const DELIVERY_TTL_MS = 4 * 24 * 60 * 60 * 1000;

/** Expired delivery ids deleted per recorded push, so the table stays bounded without a sweep of its own. */
const DELIVERY_PRUNE_BATCH = 20;

type ClaimResult = null | { buildId: Id<"builds">; commitSha: string; projectId: Id<"projects">; rootDirectory?: string };

/**
 * Why a production push of an already-built commit must NOT re-release it, or
 * `undefined` when it may: the push moved `branch` from the newest commit
 * pushed to it (`before`), so it is a deliberate reset to that commit rather
 * than an older push arriving late.
 */
const staleRelease = (projectBuilds: ReadonlyArray<BuildRow>, branch: string, before: string | undefined): string | undefined => {
    const head = projectBuilds
        .filter((build) => build.trigger === "push" && build.branch === branch)
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .at(0);

    if (head === undefined || before === head.commitSha) {
        return undefined;
    }

    return `not re-released: this push moved ${branch} from ${before ?? "an unknown commit"}, but the newest push recorded for it is ${head.commitSha}, so it is a stale or out-of-order delivery and would roll production back`;
};

/**
 * What a push builds: its path-filter decision, and the earlier build it
 * re-releases instead of rebuilding — unless re-releasing it would be a stale
 * push rolling production back ({@link staleRelease}), which is skipped.
 */
const planBuild = (push: {
    before: string | undefined;
    branch: string;
    changes: PushChanges;
    projectBuilds: ReadonlyArray<BuildRow>;
    rereleased: BuildRow | undefined;
    rootDirectory: string | undefined;
    trigger: BuildTrigger;
    watchPaths: ReadonlyArray<string> | undefined;
}): { decision: BuildDecision; reusesBuildId?: Id<"builds"> } => {
    const { rereleased } = push;
    const staleReason = push.trigger === "push" && rereleased !== undefined ? staleRelease(push.projectBuilds, push.branch, push.before) : undefined;

    if (staleReason !== undefined) {
        return { decision: { build: false, reason: staleReason } };
    }

    const bounded: PushChanges =
        "files" in push.changes && push.changes.files.length > MAX_CHANGED_FILES
            ? { unknown: `the push changed more than ${String(MAX_CHANGED_FILES)} files` }
            : push.changes;

    return { decision: decideBuild(bounded, push.rootDirectory, push.watchPaths), ...(rereleased === undefined ? {} : { reusesBuildId: rereleased._id }) };
};

/**
 * The newest successful build of a push's dedup key — (commit, root
 * directory, trigger, fork-ness) — and the deployment it fed, if it recorded
 * one. Newest first: once a commit was re-released, its newest build names the
 * newest deployment.
 */
const priorBuild = async (
    context: MutationContext,
    projectId: Id<"projects">,
    key: { commitSha: string; fromFork: boolean | undefined; rootDirectory: string | undefined; trigger: BuildTrigger },
): Promise<undefined | { build: BuildRow; deployment: null | { status: string } }> => {
    const { page } = await context.db.builds.findMany({ where: { commitSha: key.commitSha, projectId } }); // secret-scanner:allow -- domain field name
    const build = page
        .toSorted((a, b) => b.createdAt - a.createdAt)
        .find(
            (candidate) =>
                candidate.status === "successful" &&
                candidate.bundleHash &&
                candidate.rootDirectory === key.rootDirectory &&
                candidate.trigger === key.trigger &&
                (candidate.fromFork === true) === (key.fromFork === true),
        );

    if (build === undefined) {
        return undefined;
    }

    const deployment = build.deploymentId == null ? null : ((await context.db.get(build.deploymentId as Id<"deployments">)) as null | { status: string });

    return { build, deployment };
};

/**
 * Whether webhook delivery `deliveryId` was recorded already; records it when
 * not, and forgets a bounded batch of ids past {@link DELIVERY_TTL_MS}.
 */
const isRedelivery = async (context: MutationContext, deliveryId: string): Promise<boolean> => {
    const { page: seen } = await context.db.githubDeliveries.findMany({ where: { deliveryId } });

    if (seen.length > 0) {
        return true;
    }

    await context.db.insert("githubDeliveries", { deliveryId, receivedAt: context.now });

    const { page: expired } = await context.db.githubDeliveries.findMany({
        limit: DELIVERY_PRUNE_BATCH,
        where: { receivedAt: { lt: context.now - DELIVERY_TTL_MS } },
    });

    for (const row of expired) {
        // eslint-disable-next-line no-await-in-loop -- a bounded batch
        await context.db.delete(row._id);
    }

    return false;
};

/** A lease older than this is stale — the runner died; the build is reclaimable. */
export const LEASE_STALE_MS = 30 * 60 * 1000;

/**
 * Record a build for a push to a connected repository (GAPS.md A4). Resolves
 * the project from the repository name itself — callers cannot aim it at an
 * arbitrary project. Reached via the HMAC-verified webhook edge route; the
 * only spoofable input is build volume, which the per-IP limiter caps.
 * Dedup: an existing successful build for (project, commitSha, rootDirectory,
 * trigger) whose release still serves — or a fork's, which never releases — is
 * returned as-is (`reused: true`) instead of queuing anything. The trigger is
 * part of the key because it decides the release: a pull request's preview
 * build must not swallow the production release of the same commit once it is
 * merged fast-forward. Fork-ness is part of it for the same reason: a fork's
 * build is never released, so it must not stand in for a release.
 *
 * A build of the same key whose release no longer serves (superseded by a
 * later push, failed, or torn down) does NOT swallow the push: pushing that
 * commit again means "deploy this". The new build names the old one
 * (`reusesBuildId`) and re-releases its stored release without rebuilding; the
 * runner rebuilds instead when that release was pruned with the rollback window,
 * and a build that never recorded a deployment is rebuilt outright.
 *
 * Never backwards: a production push re-releases an earlier build only when it
 * moved the branch from the newest commit pushed to it (`before` is that
 * commit) — a deliberate reset of the branch to an older commit. A stale or
 * out-of-order delivery of an older push carries the `before` of ITS time, so
 * it is recorded as a `skipped` build saying so, and never rolls production
 * back over the newer release. A redelivered webhook (its `X-GitHub-Delivery`
 * id seen before, `deliveryId`) records nothing at all (`duplicate`).
 *
 * Path filter: a push whose changed files match none of the project's watch
 * paths is recorded as a `skipped` build carrying the reason, so the Builds tab
 * says why nothing deployed instead of showing nothing. A push that cannot
 * prove its changed files builds (see `decideBuild`).
 */
export const recordPush = internalMutation
    .use(rateLimit("machine"))
    .input({
        // The commit the push moved the branch from (`push` payloads only).
        before: v.optional(boundedString(LIMITS.id)),
        branch: boundedString(LIMITS.gitRef),
        changes: pushChangesValidator,
        commitSha: boundedString(LIMITS.id),
        // The webhook's `X-GitHub-Delivery` id, which a redelivery repeats.
        deliveryId: v.optional(boundedString(LIMITS.id)),
        // A pull request whose head is a fork's: built, never released.
        fromFork: v.optional(v.boolean()),
        installationId: v.number(),
        pullRequest: v.optional(v.number()),
        repository: boundedString(LIMITS.token),
        trigger: v.union(v.literal("push"), v.literal("pull_request")),
    })
    .mutation(
        async ({
            ctx: context,
            args: { before, branch, changes, commitSha, deliveryId, fromFork, installationId, pullRequest, repository, trigger },
        }): Promise<RecordPushResult> => {
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

            const { now } = context;

            if (deliveryId !== undefined && (await isRedelivery(context, deliveryId))) {
                return { duplicate: true };
            }

            const { rootDirectory, watchPaths } = project;
            const prior = await priorBuild(context, project._id, { commitSha, fromFork, rootDirectory, trigger });

            if (prior && (prior.build.fromFork === true || (prior.deployment !== null && SERVING_STATUSES.has(prior.deployment.status)))) {
                return { buildId: prior.build._id, reused: true };
            }

            // Only a build that recorded a deployment has a stored release to re-release.
            const rereleased = prior?.deployment == null ? undefined : prior.build;
            const { page: projectBuilds } = await context.db.builds.findMany({ where: { projectId: project._id } }); // secret-scanner:allow -- domain field name
            const { decision, reusesBuildId } = planBuild({ before, branch, changes, projectBuilds, rereleased, rootDirectory, trigger, watchPaths });
            const common = {
                branch,
                commitSha,
                createdAt: now,
                ...(fromFork === true ? { fromFork: true } : {}),
                organizationId: project.organizationId,
                projectId: project._id, // secret-scanner:allow -- domain field name
                ...(pullRequest === undefined ? {} : { pullRequest }),
                ...(reusesBuildId === undefined ? {} : { reusesBuildId }),
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
        },
    );

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
            ...(project.productionAlias == null ? {} : { productionAlias: project.productionAlias }),
            branch: build.branch,
            ...(build.fromFork === true ? { fromFork: true } : {}),
            organizationId: build.organizationId,
            projectId: build.projectId, // secret-scanner:allow -- domain field name
            projectSlug: project.slug,
            ...(build.pullRequest === undefined ? {} : { pullRequest: build.pullRequest }),
            ...(build.trigger === undefined ? {} : { trigger: build.trigger }),
        };
    });

/** The stored release a build re-releases: the earlier build's deployment, its bundle hash and its crons. */
export interface ReusableRelease {
    bundleHash: string;
    cronSpecs?: string[];
    deploymentId: string;
}

/**
 * What a build that re-releases an earlier one (`reusesBuildId`, set by
 * {@link recordPush}) re-releases: that build's deployment — whose payload the
 * runner reads from `RELEASES` — its bundle hash, and the crons the deployment
 * ran with. `null` for a build that reuses nothing, or whose earlier build is
 * gone or not this project's; the runner then builds from source. SYSTEM only.
 */
export const reusableRelease = internalQuery
    .input({ buildId: v.id("builds") })
    .query(async ({ ctx: context, args: { buildId } }): Promise<null | ReusableRelease> => {
        const build = (await context.db.get(buildId)) as BuildRow | null;

        if (build?.reusesBuildId == null) {
            return null;
        }

        const earlier = (await context.db.get(build.reusesBuildId)) as BuildRow | null;

        if (earlier?.projectId !== build.projectId || earlier.deploymentId == null || earlier.bundleHash == null) {
            return null;
        }

        const deployment = (await context.db.get(earlier.deploymentId as Id<"deployments">)) as null | { cronSpecs?: null | string[]; projectId: string };

        if (deployment?.projectId !== build.projectId) {
            return null;
        }

        return {
            bundleHash: earlier.bundleHash,
            ...(deployment.cronSpecs == null ? {} : { cronSpecs: deployment.cronSpecs }),
            deploymentId: earlier.deploymentId,
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
