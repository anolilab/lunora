/**
 * Git build → release (GAPS.md A3): the runner's `release` port.
 *
 * A pushed build is released through the deploy core `POST /v1/deploy` runs
 * ({@link startRelease} in `src/deploy/handler.ts`) — the same validation, the
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
import type { ReleaseCaller, ReleaseFrame, ReleaseRequest, StartedRelease } from "../deploy/handler";
import { previewScriptName } from "../deploy/preview";
import type { BuildExecution, BuildRelease, ClaimedBuild } from "./runner";

/** What the release needs to know about a build beyond its claim. */
export interface BuildReleaseTarget {
    /** The project's current production alias, once it has one. */
    activeScriptName?: string;
    branch: string;
    organizationId: string;
    projectId: string; // secret-scanner:allow -- domain field name
    projectSlug: string;
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
 * yet takes the wrangler `name`, then its slug. Either way the alias is claimed
 * through the ownership ledger when the deployment is recorded, so a name in a
 * tenant's config can only reach a Worker the project owns or a new one.
 * Previews are per branch on top of that alias (`acme-pr-feat-x`, TTL'd by
 * `deployments.create`), so repeated pushes to one pull request update one Worker.
 */
export const releaseRoute = (target: BuildReleaseTarget, execution: Pick<BuildExecution, "scriptName">): { kind: BuildRelease["kind"]; scriptName: string } => {
    const alias = target.activeScriptName ?? execution.scriptName ?? target.projectSlug;

    return target.trigger === "push" ? { kind: "production", scriptName: alias } : { kind: "preview", scriptName: previewScriptName(alias, target.branch) };
};

const text = (frame: ReleaseFrame, key: string): string | undefined => {
    const value = frame[key];

    return typeof value === "string" ? value : undefined;
};

/**
 * One release frame as a build log line. The frames are the NDJSON a CLI deploy
 * prints; here they read as a continuation of the build's own output.
 */
export const describeReleaseFrame = (frame: ReleaseFrame): { level: "error" | "info"; line: string } => {
    const error = text(frame, "error");
    const phase = text(frame, "phase");
    const event = text(frame, "event");
    const url = text(frame, "url");
    const to = text(frame, "to");
    const reason = text(frame, "reason");

    let line: string;

    if (frame["done"] === true) {
        line = `release: done (${text(frame, "status") ?? "unknown"})`;
    } else if (phase === undefined) {
        line = `release: ${event ?? "progress"}${to === undefined ? "" : ` to ${to}`}`;
    } else {
        line = `release: ${phase}${url === undefined ? "" : ` ${url}`}`;
    }

    const detail = error ?? reason;
    const failed = error !== undefined || phase === "failed";

    return { level: failed ? "error" : "info", line: detail === undefined ? line : `${line}: ${detail}` };
};

/**
 * Release one successful build. Throws when nothing could be recorded (no
 * manifest, no project, a refused payload); answers with `error` when a
 * deployment was recorded and did not go live. Never leaves its key behind.
 */
export const releaseBuild = async (build: ClaimedBuild, execution: BuildExecution, ports: BuildReleasePorts): Promise<BuildRelease> => {
    if (execution.manifest === undefined) {
        throw new Error("this build carries no binding manifest, so it cannot be released: the build box predates release payloads");
    }

    const target = await ports.target(build.buildId);

    if (!target) {
        throw new Error("the build's project no longer exists");
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
