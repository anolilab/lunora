import { describe, expect, it } from "vitest";

import type { BuildReleasePorts, BuildReleaseTarget } from "../src/builds/release";
import { describeReleaseFrame, FORK_RELEASE_SKIP_REASON, releaseBuild, releaseRoute } from "../src/builds/release";
import type { BuildExecution } from "../src/builds/runner";
import { createDeployPacer } from "../src/deploy/pacing";
import type { DeployBackend, DeployHandlerDeps } from "../src/deploy/release-core";
import { startRelease } from "../src/deploy/release-core";
import type { TargetDriver } from "../src/targets/driver";
import memoryReleaseStore from "./_helpers/memory-release-store";
import { fakeDriver } from "./support/memory-driver";

type Provisioner = Pick<TargetDriver, "deploy" | "destroy">;

/**
 * A git build's release: routed to production or a preview by what recorded the
 * build, and run through the REAL deploy core (`startRelease`) — the same one
 * `POST /v1/deploy` runs — over fake backend/driver ports.
 */

const build = { buildId: "bld_1", commitSha: "abc1234", projectId: "prj_1" }; // secret-scanner:allow -- domain field name

const MANIFEST = { bindings: [{ binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" }] };

const execution: BuildExecution = {
    bundle: btoa("export default {}"),
    bundleHash: "hash-1",
    cronSpecs: ["0 0 * * *"],
    manifest: MANIFEST,
    scriptName: "from-wrangler",
};

const pushTarget: BuildReleaseTarget = { branch: "main", organizationId: "org_1", projectId: "prj_1", projectSlug: "web", trigger: "push" };

const okProvisioner: Provisioner = {
    deploy: (spec) => Promise.resolve({ url: `https://${spec.alias}.lunora.app` }),
    destroy: () => Promise.resolve(),
};

interface Harness {
    created: Record<string, unknown>[];
    keys: { minted: { buildId: string; kind: string; projectId: string }[]; revoked: number };
    logs: string[];
    objects: Map<string, string>;
    ports: BuildReleasePorts;
    statuses: string[];
}

const harness = (options: { progress?: string[]; provisioner?: Provisioner; target?: BuildReleaseTarget | null } = {}): Harness => {
    const created: Record<string, unknown>[] = [];
    const statuses: string[] = [];
    const logs: string[] = [];
    const keys: Harness["keys"] = { minted: [], revoked: 0 };
    const { objects, store } = memoryReleaseStore();

    const backend: DeployBackend = {
        activateDeployment: ({ deploymentId }) => {
            statuses.push(`activate:${deploymentId}`);

            return Promise.resolve();
        },
        createDeployment: (input) => {
            created.push(input);

            return Promise.resolve({ deploymentId: "dep_1" });
        },
        placement: () => Promise.resolve({ target: "cloudflare-wfp" }),
        releaseTarget: () => Promise.reject(new Error("no release target in this test")),
        rollbackDeployment: () => Promise.reject(new Error("no rollback in this test")),
        updateStatus: ({ status }) => {
            statuses.push(status);

            return Promise.resolve();
        },
        verifyKey: () => Promise.reject(new Error("a build release never presents a key over HTTP")),
    };
    const deps: DeployHandlerDeps = {
        backend,
        driverFor: () => {
            const provisioner = options.provisioner ?? okProvisioner;

            return fakeDriver({
                ...provisioner,
                // A target that streams its converge, as a box does.
                deploy: (spec, convergeOptions) => {
                    for (const line of options.progress ?? []) {
                        convergeOptions?.onProgress?.(line);
                    }

                    return provisioner.deploy(spec);
                },
            });
        },
        healthCheck: () => Promise.resolve(true),
        releases: store,
        pacer: createDeployPacer(),
    };

    return {
        created,
        keys,
        logs,
        objects,
        ports: {
            log: (_buildId, level, line) => {
                logs.push(`${level}:${line}`);

                return Promise.resolve();
            },
            mintKey: (target, kind, buildId) => {
                keys.minted.push({ buildId, kind, projectId: target.projectId }); // secret-scanner:allow -- domain field name

                return Promise.resolve({
                    key: `${kind}:${target.organizationId}:${target.projectId}|secret`,
                    revoke: () => {
                        keys.revoked += 1;

                        return Promise.resolve();
                    },
                });
            },
            start: (request, caller) => startRelease(request, caller, deps),
            target: () => Promise.resolve(options.target === undefined ? pushTarget : options.target),
        },
        statuses,
    };
};

describe(releaseRoute, () => {
    it("releases a default-branch push to production on the project's existing alias", () => {
        expect(releaseRoute({ ...pushTarget, activeScriptName: "acme-web" }, execution)).toStrictEqual({ kind: "production", scriptName: "acme-web" });
    });

    it("releases a first production release on the alias reserved when the project was created, not the wrangler name", () => {
        expect(releaseRoute({ ...pushTarget, productionAlias: "web-0f9a1c2e" }, execution)).toStrictEqual({ kind: "production", scriptName: "web-0f9a1c2e" });
        // A project that already serves keeps its alias.
        expect(releaseRoute({ ...pushTarget, activeScriptName: "acme-web", productionAlias: "web-0f9a1c2e" }, execution).scriptName).toBe("acme-web");
    });

    it("falls back to the wrangler name, then the project slug, for a project that predates reserved aliases", () => {
        expect(releaseRoute(pushTarget, execution)).toStrictEqual({ kind: "production", scriptName: "from-wrangler" });
        expect(releaseRoute(pushTarget, {})).toStrictEqual({ kind: "production", scriptName: "web" });
    });

    it("releases a pull request to a per-branch preview", () => {
        expect(releaseRoute({ ...pushTarget, activeScriptName: "acme-web", branch: "feat/Login", trigger: "pull_request" }, execution)).toStrictEqual({
            kind: "preview",
            scriptName: "acme-web-pr-feat-login",
        });
    });

    it("names a fork's preview by its pull request number, so it cannot land on a team branch's preview", () => {
        const fork: BuildReleaseTarget = {
            ...pushTarget,
            activeScriptName: "acme-web",
            branch: "feat/login",
            fromFork: true,
            pullRequest: 12,
            trigger: "pull_request",
        };

        expect(releaseRoute(fork, execution)).toStrictEqual({ kind: "preview", scriptName: "acme-web-fork-12" });
        expect(releaseRoute({ ...fork, fromFork: undefined }, execution).scriptName).toBe("acme-web-pr-feat-login");
    });

    it("never takes a fork's build to production, whatever its trigger says", () => {
        expect(releaseRoute({ ...pushTarget, fromFork: true, pullRequest: 3 }, execution).kind).toBe("preview");
    });

    it("never takes a build without a recorded trigger to production", () => {
        const legacy: BuildReleaseTarget = { branch: "main", organizationId: "org_1", projectId: "prj_1", projectSlug: "web" };

        expect(releaseRoute(legacy, execution).kind).toBe("preview");
    });
});

describe(describeReleaseFrame, () => {
    it("reads progress as info and failures as errors", () => {
        expect(describeReleaseFrame({ deploymentId: "dep_1", phase: "live", url: "https://x.lunora.app" })).toStrictEqual({
            level: "info",
            line: "release: live https://x.lunora.app",
        });
        expect(describeReleaseFrame({ deploymentId: "dep_1", error: "boom", phase: "failed" })).toStrictEqual({
            level: "error",
            line: "release: failed: boom",
        });
        expect(describeReleaseFrame({ deploymentId: "dep_1", event: "reverting", to: "dep_0" })).toStrictEqual({
            level: "info",
            line: "release: reverting to dep_0",
        });
        expect(describeReleaseFrame({ deploymentId: "dep_1", done: true, status: "live" })).toStrictEqual({ level: "info", line: "release: done (live)" });
    });

    it("writes the target's own progress lines into the build log", () => {
        expect(describeReleaseFrame({ deploymentId: "dep_1", log: "pulling release dep_1 onto the box" })).toStrictEqual({
            level: "info",
            line: "release: pulling release dep_1 onto the box",
        });
    });

    it("reads every event frame, failures as errors", () => {
        expect(describeReleaseFrame({ deploymentId: "dep_1", event: "accepted" })).toStrictEqual({ level: "info", line: "release: accepted" });
        expect(describeReleaseFrame({ deploymentId: "dep_1", event: "not_reverted", reason: "no previous release to revert to" })).toStrictEqual({
            level: "info",
            line: "release: not_reverted: no previous release to revert to",
        });
        expect(describeReleaseFrame({ deploymentId: "dep_1", error: "box offline", event: "revert_failed", to: "dep_0" })).toStrictEqual({
            level: "error",
            line: "release: revert_failed to dep_0: box offline",
        });
    });
});

describe(releaseBuild, () => {
    it("records a production deployment through the deploy core, streams its progress, and deletes the key", async () => {
        const { created, keys, logs, objects, ports, statuses } = harness();

        const released = await releaseBuild(build, execution, ports);

        expect(released).toStrictEqual({ deploymentId: "dep_1", kind: "production", url: "https://from-wrangler.lunora.app" });
        expect(created).toStrictEqual([
            expect.objectContaining({
                branch: "main",
                cronSpecs: ["0 0 * * *"],
                key: "production:org_1:prj_1|secret",
                kind: "production",
                organizationId: "org_1",
                projectId: "prj_1",
                scriptName: "from-wrangler",
            }),
        ]);
        // Stored for rollback, exactly as a CLI deploy is.
        expect(objects.has("releases/dep_1.json")).toBe(true);
        expect(statuses).toStrictEqual(["provisioning", "verifying", "live", "activate:dep_1"]);
        expect(logs).toContain("info:releasing from-wrangler as production");
        expect(logs).toContain("info:release: live https://from-wrangler.lunora.app");
        expect(logs.at(-1)).toBe("info:release: done (live)");
        expect(keys).toStrictEqual({ minted: [{ buildId: "bld_1", kind: "production", projectId: "prj_1" }], revoked: 1 });
    });

    it("writes a target's converge progress into the build log", async () => {
        const { logs, ports } = harness({ progress: ["fetching release dep_1", "fleet web healthy"] });

        await releaseBuild(build, execution, ports);

        expect(logs).toStrictEqual(expect.arrayContaining(["info:release: fetching release dep_1", "info:release: fleet web healthy"]));
    });

    it("records a pull request's build as a preview, with a preview-ceiling key", async () => {
        const { created, keys, ports } = harness({ target: { ...pushTarget, branch: "feat/x", trigger: "pull_request" } });

        const released = await releaseBuild(build, execution, ports);

        expect(released).toMatchObject({ kind: "preview" });
        expect(created[0]).toMatchObject({ branch: "feat/x", kind: "preview", scriptName: "from-wrangler-pr-feat-x" });
        expect(keys.minted[0]?.kind).toBe("preview");
    });

    it("answers with the error when the deployment was recorded but failed — and still deletes the key", async () => {
        const failing: Provisioner = { deploy: () => Promise.reject(new Error("provision box down")), destroy: () => Promise.resolve() };
        const { keys, logs, ports, statuses } = harness({ provisioner: failing });

        const released = await releaseBuild(build, execution, ports);

        expect(released).toStrictEqual({ deploymentId: "dep_1", error: "provision box down", kind: "production" });
        expect(statuses).toContain("failed");
        expect(logs).toContain("error:release: failed: provision box down");
        expect(keys.revoked).toBe(1);
    });

    it("throws, recording nothing, when the deploy core refuses the payload", async () => {
        const { created, keys, ports } = harness();
        const refused = { ...execution, manifest: { bindings: [{ binding: "DB", type: "not-a-binding" }] } };

        await expect(releaseBuild(build, refused, ports)).rejects.toThrow(/unknown type/u);
        expect(created).toStrictEqual([]);
        expect(keys.revoked).toBe(1);
    });

    it("refuses a build with no manifest before minting anything", async () => {
        const { keys, ports } = harness();
        const bundleOnly: BuildExecution = { bundle: execution.bundle, bundleHash: execution.bundleHash };

        await expect(releaseBuild(build, bundleOnly, ports)).rejects.toThrow(/no binding manifest/u);
        expect(keys.minted).toStrictEqual([]);
    });

    it("never releases a fork's pull request: no key minted, the deploy core (and so its secrets) never reached", async () => {
        const { created, keys, ports } = harness({ target: { ...pushTarget, branch: "feat/x", fromFork: true, pullRequest: 9, trigger: "pull_request" } });
        let started = 0;
        const { start } = ports;

        const released = await releaseBuild(build, execution, {
            ...ports,
            start: (request, caller) => {
                started += 1;

                return start(request, caller);
            },
        });

        expect(released).toStrictEqual({ skipped: FORK_RELEASE_SKIP_REASON });
        expect(started).toBe(0);
        expect(keys).toStrictEqual({ minted: [], revoked: 0 });
        expect(created).toStrictEqual([]);
    });

    it("refuses a build whose project is gone", async () => {
        const { keys, ports } = harness({ target: null });

        await expect(releaseBuild(build, execution, ports)).rejects.toThrow(/no longer exists/u);
        expect(keys.minted).toStrictEqual([]);
    });
});
