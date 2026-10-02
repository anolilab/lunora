/**
 * The build queue's drain, wired to the control-plane Worker (GAPS.md A3).
 *
 * `builds.recordPush` enqueues, `claimNext` leases and `runBuild` drives a
 * build through fetch → execute → release → complete/fail. This joins them to
 * the real ports. It runs in the Worker — on `POST /v1/builds/dispatch`, which
 * the Worker's own `scheduled()` calls once a minute — rather than in a Lunora
 * cron action, because the release half needs what only the Worker's env holds:
 * the `RELEASES` bucket, the provision box and the master key. An action's
 * `ctx.env` carries the declared vars and nothing else.
 */
import type { ContainerAccessor } from "@lunora/container";
import { containerBindingName, createContainerContext } from "@lunora/container";
import { LunoraError } from "@lunora/server";

import { internal } from "../../lunora/_generated/api.js";
import { buildBox } from "../../lunora/containers";
import type { DeployHandlerDeps } from "../deploy/handler";
import { startRelease } from "../deploy/handler";
import { formatDeployKey, hashDeployKey, randomSecret } from "../deploy/keys";
import type { LunoraActionContext, RouterEnv } from "../deploy/routes/shared";
import { createGitHubApp } from "../github/app";
import { executeInContainer } from "./container-exec";
import { runBuildDispatch } from "./dispatch";
import type { BuildReleaseTarget } from "./release";
import { releaseBuild } from "./release";
import type { BuildRunnerPorts, ClaimedBuild } from "./runner";
import { BUILD_EXECUTE_BUDGET_MS, UNCONFIGURED_MARKER, withinBudget } from "./runner";

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

/**
 * Claim and run queued builds, releasing each successful one.
 *
 * `deploy` is the deploy core's wiring (`deployDeps` in `router.ts`), the same
 * object `POST /v1/deploy` runs on; `undefined` on a cell without a `RELEASES`
 * bucket, where builds still run and their release fails with the reason.
 */
export const dispatchBuilds = async (input: {
    context: LunoraActionContext;
    deploy: DeployHandlerDeps | undefined;
    environment: RouterEnv;
}): Promise<{ ran: number }> => {
    const { context, deploy, environment } = input;
    // Identifies this tick's leases. Random rather than derived: unlike the
    // action this replaced, a Worker invocation is never re-run under OCC retry,
    // so there is no earlier lease of its own to rejoin.
    const runnerId = `edge-${crypto.randomUUID()}`;

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
        // Bounded so the release still fits the scheduled invocation this runs in
        // (`SCHEDULED_INVOCATION_LIMIT_MS`); the box's own timeouts are longer.
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

    const { outcomes } = await runBuildDispatch({
        claimNext: async (id) => await context.runMutation<ClaimedBuild | null>(internal.builds.claimNext, { runnerId: id }),
        runnerId,
        runnerPorts,
    });

    return { ran: outcomes.length };
};
