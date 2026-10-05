/**
 * Git build → release (GAPS.md A3): the runner's `release` port.
 *
 * A pushed build is released through the deploy core `POST /v1/deploy` runs
 * ({@link startRelease} in `src/deploy/release-core.ts`) — the same validation, the
 * same stored release, the same health gate and automatic revert. Nothing here
 * re-implements a step of it; this module only decides what a CLI caller would
 * have decided on the command line (which project, which kind, which script),
 * and writes the run's progress into the build's log instead of an HTTP stream.
 *
 * Every backend call in that core is authorized by a deploy key, and a build has
 * none — so it gets one: minted per release, scoped to the build's own project
 * and kind, and deleted when the release ends. That keeps every authorization
 * check, ceiling and audit row identical to a CLI deploy instead of growing a
 * second, key-less path through each of them.
 *
 * Pure over {@link BuildReleasePorts}, so the routing and the log shape test
 * without a control plane.
 */
import { forkPreviewScriptName, previewScriptName } from "../deploy/preview";
import type { ReleaseCaller, ReleaseFrame, ReleaseRequest, StartedRelease } from "../deploy/release-core";
import type { BuildExecution, BuildRelease, BuildReleaseSkipped, ClaimedBuild } from "./runner";

/** What the release needs to know about a build beyond its claim. */
export interface BuildReleaseTarget {
    /** The project's current production alias, once it has one. */
    activeScriptName?: string;
    branch: string;
    /** The build is a fork's pull request — built, never released. */
    fromFork?: boolean;
    organizationId: string;
    /** The alias reserved for the project's production when it was created (`projects.productionAlias`). */
    productionAlias?: string;
    projectId: string; // secret-scanner:allow -- domain field name
    projectSlug: string;
    /** The pull request number, on `pull_request` builds that recorded one. */
    pullRequest?: number;
    /** What recorded the build. Absent on rows that predate it, which release as previews. */
    trigger?: "pull_request" | "push";
}

/** A deploy key minted for one release. */
export interface ReleaseKey {
    key: string;
    /** Delete the key. Called once the release has ended, whatever its outcome. */
    revoke: () => Promise<void>;
}

export interface BuildReleasePorts {
    /** Write one line into the build's `buildLogs` (lease-checked upstream). */
    log: (buildId: string, level: "error" | "info", line: string) => Promise<void>;
    /** Mint a deploy key scoped to the build's project, with `kind` as its ceiling. */
    mintKey: (target: BuildReleaseTarget, kind: BuildRelease["kind"], buildId: string) => Promise<ReleaseKey>;
    /** The deploy core: {@link startRelease} bound to this cell's deploy deps. */
    start: (request: ReleaseRequest, caller: ReleaseCaller) => Promise<StartedRelease>;
    /** Resolve the build's project and trigger, or `null` when the build is gone. */
    target: (buildId: string) => Promise<BuildReleaseTarget | null>;
}

/**
 * Which kind of release a build is, and which Worker it lands on.
 *
 * A push to the default branch is production; anything else — a pull request,
 * or a row older than the `trigger` column — is a preview, which can never move
 * the project's stable URL. Production reuses the project's existing alias, so
 * a git release updates the same Worker a CLI deploy did; a project with none
 * yet takes the alias reserved for it at creation — free of every other
 * organization's by construction — and only a project that predates
 * reservations falls back to the wrangler `name`, then its slug. Either way the alias is claimed
 * through the ownership ledger when the deployment is recorded, so a name in a
 * tenant's config can only reach a Worker the project owns or a new one.
 * Previews are per branch on top of that alias (`acme-pr-feat-x`, TTL'd by
 * `deployments.create`), so repeated pushes to one pull request update one Worker.
 * A fork's pull request is named by its number instead of its branch, which
 * the fork chose ({@link forkPreviewScriptName}) — though {@link releaseBuild}
 * never releases one at all.
 */
export const releaseRoute = (target: BuildReleaseTarget, execution: Pick<BuildExecution, "scriptName">): { kind: BuildRelease["kind"]; scriptName: string } => {
    const alias = target.activeScriptName ?? target.productionAlias ?? execution.scriptName ?? target.projectSlug;

    if (target.trigger === "push" && target.fromFork !== true) {
        return { kind: "production", scriptName: alias };
    }

    return {
        kind: "preview",
        scriptName: target.fromFork === true ? forkPreviewScriptName(alias, target.pullRequest) : previewScriptName(alias, target.branch),
    };
};

/**
 * Why a fork's pull request is not released. Shown in the build log and on the
 * commit status, so a contributor sees the build passed and why nothing deployed.
 */
export const FORK_RELEASE_SKIP_REASON = "fork pull requests are built but not deployed";

/** A release event frame — everything that is not a phase, a log line or the terminal frame. */
type EventFrame = Extract<ReleaseFrame, { event: string }>;

const describeEvent = (frame: EventFrame): { level: "error" | "info"; line: string } => {
    switch (frame.event) {
        case "accepted":
        case "released": {
            return { level: "info", line: `release: ${frame.event}` };
        }
        case "not_reverted": {
            return { level: "info", line: `release: not_reverted: ${frame.reason}` };
        }
        case "revert_failed": {
            return { level: "error", line: `release: revert_failed to ${frame.to}: ${frame.error}` };
        }
        case "reverted":
        case "reverting": {
            return { level: "info", line: `release: ${frame.event} to ${frame.to}` };
        }
        default: {
            // A frame added to `ReleaseFrame` without a case here fails to compile.
            const unhandled: never = frame;

            return { level: "info", line: `release: ${JSON.stringify(unhandled)}` };
        }
    }
};

/**
 * One release frame as a build log line. The frames are the NDJSON a CLI deploy
 * prints; here they read as a continuation of the build's own output.
 */
export const describeReleaseFrame = (frame: ReleaseFrame): { level: "error" | "info"; line: string } => {
    if ("log" in frame) {
        // The target's own progress (a box's job output) — the lines that say
        // what a slow or failed converge was doing.
        return { level: "info", line: `release: ${frame.log}` };
    }

    if ("done" in frame) {
        return { level: "info", line: `release: done (${frame.status})` };
    }

    if ("phase" in frame) {
        const line = `release: ${frame.phase}${frame.url === undefined ? "" : ` ${frame.url}`}`;

        return frame.error === undefined ? { level: frame.phase === "failed" ? "error" : "info", line } : { level: "error", line: `${line}: ${frame.error}` };
    }

    return describeEvent(frame);
};

/**
 * Release one successful build. Throws when nothing could be recorded (no
 * manifest, no project, a refused payload); answers with `error` when a
 * deployment was recorded and did not go live. Never leaves its key behind.
 *
 * A fork's pull request answers `skipped` before anything is minted or started:
 * a release resolves the project's `preview` and `all` secrets and injects the
 * org's ingest key into the Worker, so releasing a fork's code would hand both
 * to whoever opened the pull request.
 */
export const releaseBuild = async (build: ClaimedBuild, execution: BuildExecution, ports: BuildReleasePorts): Promise<BuildRelease | BuildReleaseSkipped> => {
    const target = await ports.target(build.buildId);

    if (!target) {
        throw new Error("the build's project no longer exists");
    }

    if (target.fromFork === true) {
        return { skipped: FORK_RELEASE_SKIP_REASON };
    }

    if (execution.manifest === undefined) {
        throw new Error("this build carries no binding manifest, so it cannot be released: the build box predates release payloads");
    }

    const { kind, scriptName } = releaseRoute(target, execution);

    await ports.log(build.buildId, "info", `releasing ${scriptName} as ${kind}`);

    const minted = await ports.mintKey(target, kind, build.buildId);

    try {
        const started = await ports.start(
            {
                ...(execution.assets === undefined ? {} : { assets: execution.assets }),
                branch: target.branch,
                bundle: execution.bundle,
                ...(execution.cronSpecs === undefined ? {} : { cronSpecs: execution.cronSpecs }),
                kind,
                manifest: execution.manifest,
                projectId: target.projectId, // secret-scanner:allow -- domain field name
                scriptName,
            },
            { key: minted.key, organizationId: target.organizationId },
        );

        if ("error" in started) {
            throw new Error(started.error);
        }

        // `write` is synchronous and a log write is not, so the lines are chained:
        // they land in order, and one that fails to land never fails the release.
        let logged = Promise.resolve();
        const outcome = await started.run((frame) => {
            const { level, line } = describeReleaseFrame(frame);

            logged = logged.then(() => ports.log(build.buildId, level, line)).catch(() => {});
        });

        await logged;

        return {
            deploymentId: outcome.deploymentId,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
            kind,
            ...(outcome.url === undefined ? {} : { url: outcome.url }),
        };
    } finally {
        // The key existed only for this release. A failed delete leaves a
        // project-scoped key nobody holds the plaintext of, visible in the
        // org's key list — worth a line, never worth failing the release over.
        try {
            await minted.revoke();
        } catch {
            await ports.log(build.buildId, "error", "could not delete this release's deploy key; revoke it from the Deploy keys tab").catch(() => {});
        }
    }
};
