/**
 * The build queue, wired to the control-plane Worker (GAPS.md A3).
 *
 * `builds.recordPush` enqueues; {@link dispatchBuilds} (`POST /v1/builds/dispatch`,
 * called by the Worker's every-minute `scheduled()`) claims builds and hands
 * each to its own build runner (`BUILD_RUNNER`, `src/builds/runner-do.ts`);
 * {@link runBuildStage} (`POST /v1/builds/run`, called in-process by that
 * runner's alarms) runs one half of a build against the real ports. All of it
 * runs in the Worker rather than a Lunora cron action, because the release half
 * needs what only the Worker's env holds: the `RELEASES` bucket, the provision
 * box and the master key. An action's `ctx.env` carries the declared vars and
 * nothing else.
 */
import type { ContainerAccessor } from "@lunora/container";
import { containerBindingName, createContainerContext } from "@lunora/container";
import { LunoraError } from "@lunora/server";

import { internal } from "../../lunora/_generated/api.js";
import type { ReusableRelease } from "../../lunora/builds";
import { buildBox } from "../../lunora/containers";
import { formatDeployKey, hashDeployKey, randomSecret } from "../deploy/keys";
import type { DeployHandlerDeps } from "../deploy/release-core";
import { startRelease } from "../deploy/release-core";
import type { LunoraActionContext, RouterEnv } from "../deploy/routes/shared";
import { createGitHubApp } from "../github/app";
import { executeInContainer } from "./container-exec";
import { claimBuilds } from "./dispatch";
import { createBuildExecutionStore } from "./execution-store";
import type { BuildReleaseTarget } from "./release";
import { releaseBuild } from "./release";
import type { BuildRunnerPorts, ClaimedBuild } from "./runner";
import { BUILD_EXECUTE_BUDGET_MS, executeBuild, finishBuild, UNCONFIGURED_MARKER, withinBudget } from "./runner";
import type { BuildJob, BuildRunnerNamespace, BuildStage } from "./runner-job";

/** The build box's Container DO namespace, the way `provisionBoxFrom` reaches the provision box. */
const buildBoxFrom = (environment: Record<string, unknown>): ContainerAccessor =>
    createContainerContext(environment, [{ binding: containerBindingName("buildBox"), exportName: "buildBox", maxInstances: buildBox.maxInstances }]).buildBox;

/**
 * A port that cannot run until the platform is provisioned, failing with the
 * reason.
 *
 * That failure is the point. Before the dispatcher was wired, a pushed build sat
 * `pending` with nobody to claim it and was failed 24 hours later by the expiry
 * cron, with no explanation anywhere. Failing in the first minute, with the cause
 * written to `buildLogs`, is strictly better than silence. The message carries
 * {@link UNCONFIGURED_MARKER}, which keeps the platform's own missing
 * infrastructure from reading as the tenant's failure (see `runner.ts`).
 */
const unconfigured = (what: string, why: string) => (): never => {
    throw new LunoraError("INTERNAL", `build ${what} ${UNCONFIGURED_MARKER} ${why}`);
};

/** What a build's ports are wired to. */
interface BuildWiring {
    context: LunoraActionContext;
    /** The deploy core's wiring (`deployDeps`), the same object `POST /v1/deploy` runs on; `undefined` without a `RELEASES` bucket. */
    deploy: DeployHandlerDeps | undefined;
    environment: RouterEnv & { BUILD_RUNNER?: BuildRunnerNamespace };
}

/** The runner ports for one build's lease. Without `deploy`, the release fails with the reason. */
const runnerPortsFor = (input: BuildWiring, runnerId: string): BuildRunnerPorts => {
    const { context, deploy, environment } = input;

    // Absent App credentials this is `null`, and the runner reports to nobody —
    // the same 🌐 gate the source fetch sits behind, since it is the same credential.
    const app = createGitHubApp({ appId: environment.GITHUB_APP_ID, privateKeyPem: environment.GITHUB_APP_PRIVATE_KEY });
    const reportTarget = (build: ClaimedBuild) =>
        context.runQuery<null | { commitSha: string; installationId: number; repository: string }>(internal.builds.reportTarget, { buildId: build.buildId });
    const appendLog: BuildRunnerPorts["appendLog"] = async (buildId, level, line) => {
        await context.runMutation(internal.builds.appendLog, { buildId, level, line, runnerId });
    };

    const runnerPorts: BuildRunnerPorts = {
        appendLog,
        complete: async (buildId, bundleHash, deploymentId) => {
            await context.runMutation(internal.builds.complete, { buildId, bundleHash, ...(deploymentId === undefined ? {} : { deploymentId }), runnerId });
        },
        // `.any()` — a build is stateless, so any instance will do, and `.any()`
        // is the handle that retries THROUGH a cold start (a 503 "no instance"
        // while Cloudflare provisions) while letting a genuine 5xx from a
        // running box pass straight through. Retrying a real build failure
        // would just pay for the same install twice.
        // Bounded so the build half fits the alarm it runs in
        // (`ALARM_INVOCATION_LIMIT_MS`); the box's own timeouts are longer.
        execute: async (source, rootDirectory, onLine) =>
            await withinBudget(executeInContainer(buildBoxFrom(environment).any(), source, rootDirectory, onLine), BUILD_EXECUTE_BUDGET_MS, "the build"),
        fail: async (buildId, error) => {
            await context.runMutation(internal.builds.fail, { buildId, error, runnerId });
        },
        fetchSource:
            app === null
                ? unconfigured(
                      "source fetch",
                      "the control plane has no GitHub App credentials (app id + private key) to mint an installation token. Builds cannot run until it is provisioned.",
                  )
                : async (build) => {
                      // Same row the status reporter reads: the installation to
                      // authenticate as, the repository, and the commit.
                      const target = await reportTarget(build);

                      if (!target) {
                          throw new LunoraError(
                              "INTERNAL",
                              "this build has no GitHub source to fetch: the project has no `githubRepo`, or the organization has no claimed App installation",
                          );
                      }

                      return await app.downloadTarball(target);
                  },
        release:
            deploy === undefined
                ? unconfigured("release", "the control plane has no RELEASES bucket; a release that is not stored could never be rolled back.")
                : (build, execution) =>
                      releaseBuild(build, execution, {
                          log: appendLog,
                          mintKey: async (target: BuildReleaseTarget, kind, buildId) => {
                              const { organizationId, projectId } = target;
                              const key = formatDeployKey({ organizationId, projectId, secret: randomSecret(), type: kind });
                              const id = await context.runMutation<string>(internal.deploy_keys.recordReleaseKey, {
                                  buildId,
                                  hashedKey: await hashDeployKey(key),
                                  organizationId,
                                  projectId,
                                  type: kind,
                              });

                              return {
                                  key,
                                  revoke: async () => {
                                      await context.runMutation(internal.deploy_keys.removeReleaseKey, { buildId, id });
                                  },
                              };
                          },
                          start: (request, caller) => startRelease(request, caller, deploy),
                          target: (buildId) => context.runQuery<BuildReleaseTarget | null>(internal.builds.releaseTarget, { buildId }),
                      }),
        ...(deploy === undefined
            ? {}
            : {
                  storedRelease: async (build) => {
                      const reusable = await context.runQuery<null | ReusableRelease>(internal.builds.reusableRelease, { buildId: build.buildId });

                      if (reusable === null) {
                          return null;
                      }

                      // Kept for the rollback window and pruned with it (the teardown sweep) — the retention bound.
                      const stored = await deploy.releases.get(reusable.deploymentId);

                      return {
                          deploymentId: reusable.deploymentId,
                          execution:
                              stored === null
                                  ? null
                                  : {
                                        ...(stored.assets === undefined ? {} : { assets: stored.assets }),
                                        bundle: stored.bundle,
                                        bundleHash: reusable.bundleHash,
                                        ...(reusable.cronSpecs === undefined ? {} : { cronSpecs: reusable.cronSpecs }),
                                        manifest: stored.manifest as unknown as Record<string, unknown>,
                                    },
                      };
                  },
              }),
        ...(app === null
            ? {}
            : {
                  reportStatus: async (build, state, description, targetUrl) => {
                      const target = await reportTarget(build);

                      if (!target) {
                          return;
                      }

                      await app.postCommitStatus({
                          description,
                          installationId: target.installationId,
                          repository: target.repository,
                          sha: target.commitSha,
                          state,
                          ...(targetUrl === undefined ? {} : { targetUrl }),
                      });
                  },
              }),
    };

    return runnerPorts;
};

/**
 * Claim queued builds and hand each to its own build runner, which builds and
 * releases it in its own alarm invocations. A cell without the `BUILD_RUNNER`
 * binding fails what it claims with the reason, as an unconfigured build box does.
 */
export const dispatchBuilds = async (input: Omit<BuildWiring, "deploy">): Promise<{ handedOff: string[] }> => {
    const { context, environment } = input;
    // Identifies these builds' leases, for every half of them. Random rather than
    // derived: a Worker invocation is never re-run under OCC retry, so there is
    // no earlier lease of its own to rejoin.
    const runnerId = `edge-${crypto.randomUUID()}`;
    const namespace = environment.BUILD_RUNNER;

    return claimBuilds({
        claimNext: async (id) => await context.runMutation<ClaimedBuild | null>(internal.builds.claimNext, { runnerId: id }),
        fail: async (buildId, error) => {
            await context.runMutation(internal.builds.fail, { buildId, error, runnerId });
        },
        handOff: async (build, id) => {
            const runner = namespace ?? unconfigured("runner", "the control plane has no BUILD_RUNNER binding to run builds in.")();

            await runner.get(runner.idFromName(build.buildId)).start({ build, runnerId: id });
        },
        runnerId,
    });
};

/** What the runner does after a stage: run the release half next, or nothing more. */
export type BuildStageResult = { next: "release" } | { next: null };

/**
 * Run one half of a build, for its runner's alarm (`POST /v1/builds/run`).
 *
 * - `build` fetches and executes it. A successful execution is stored for the
 *   release half; on a cell without a `RELEASES` bucket there is nothing to
 *   store it in, and nothing could release it either, so it finishes here.
 * - `release` releases the stored execution and completes the build.
 * - `interrupted` fails a build whose half was cut off mid-run, rather than run
 *   that half — a release, say — twice.
 */
export const runBuildStage = async (input: BuildWiring, job: BuildJob, stage: BuildStage): Promise<BuildStageResult> => {
    const ports = runnerPortsFor(input, job.runnerId);
    const { build } = job;
    const executions = input.environment.RELEASES ? createBuildExecutionStore(input.environment.RELEASES) : undefined;

    if (stage === "interrupted") {
        const message = "this build's runner was cut off mid-run (a Durable Object alarm runs for at most 15 minutes); push again to rebuild";

        await ports.appendLog(build.buildId, "error", message).catch(() => {});
        await ports.fail(build.buildId, message);

        return { next: null };
    }

    if (stage === "release") {
        const execution = await executions?.get(build.buildId);

        if (execution == null) {
            await ports.fail(build.buildId, "this build's execution was not kept for its release; push again to rebuild");

            return { next: null };
        }

        await finishBuild(build, execution, ports);
        await executions?.delete(build.buildId);

        return { next: null };
    }

    const executed = await executeBuild(build, ports);

    if ("outcome" in executed) {
        return { next: null };
    }

    if (executions === undefined) {
        await finishBuild(build, executed.execution, ports);

        return { next: null };
    }

    await executions.put(build.buildId, executed.execution);

    return { next: "release" };
};
