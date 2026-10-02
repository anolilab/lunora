import { describe, expect, it } from "vitest";

import type { BuildRunnerPorts } from "../src/builds/runner";
import { runBuild } from "../src/builds/runner";
import { parseInstallationEvent, parsePushEvent } from "../src/github/webhook";

/** Server-side builds + push-to-deploy (GAPS.md A3/A4). */

describe(parsePushEvent, () => {
    it("accepts a default-branch push", () => {
        const intent = parsePushEvent({
            after: "abc123",
            installation: { id: 42 },
            ref: "refs/heads/main",
            repository: { default_branch: "main", full_name: "acme/app" },
        });

        expect(intent).toStrictEqual({
            branch: "main",
            changes: { unknown: "the push lists no commits" },
            commitSha: "abc123",
            installationId: 42,
            repository: "acme/app",
        });
    });

    it("ignores non-default branches, branch deletes, and malformed payloads", () => {
        expect(
            parsePushEvent({
                after: "abc",
                installation: { id: 42 },
                ref: "refs/heads/feature",
                repository: { default_branch: "main", full_name: "acme/app" },
            }),
        ).toBeNull();
        expect(
            parsePushEvent({
                after: "0000000000",
                installation: { id: 42 },
                ref: "refs/heads/main",
                repository: { default_branch: "main", full_name: "acme/app" },
            }),
        ).toBeNull();
        expect(parsePushEvent({ after: "abc", ref: "refs/heads/main", repository: { default_branch: "main", full_name: "acme/app" } })).toBeNull();
        expect(parsePushEvent({})).toBeNull();
        expect(parsePushEvent(null)).toBeNull();
    });

    it("honors a non-main default branch", () => {
        const intent = parsePushEvent({
            after: "abc",
            installation: { id: 42 },
            ref: "refs/heads/trunk",
            repository: { default_branch: "trunk", full_name: "acme/app" },
        });

        expect(intent?.branch).toBe("trunk");
    });
});

describe(parseInstallationEvent, () => {
    it("maps created/deleted installations and ignores the rest", () => {
        const payload = { action: "created", installation: { account: { login: "acme" }, id: 42 } };

        expect(parseInstallationEvent(payload)).toStrictEqual({ accountLogin: "acme", action: "created", installationId: 42 });
        expect(parseInstallationEvent({ ...payload, action: "deleted" })?.action).toBe("deleted");
        expect(parseInstallationEvent({ ...payload, action: "suspend" })).toBeNull();
        expect(parseInstallationEvent({ action: "created" })).toBeNull();
    });
});

describe(runBuild, () => {
    const build = { buildId: "b1", commitSha: "abc", projectId: "p1" }; // secret-scanner:allow -- domain field name

    const portsWith = (overrides: Partial<BuildRunnerPorts>): { logs: string[]; ports: BuildRunnerPorts; terminal: string[] } => {
        const logs: string[] = [];
        const terminal: string[] = [];
        const ports: BuildRunnerPorts = {
            appendLog: (_id, level, line) => {
                logs.push(`${level}:${line}`);

                return Promise.resolve();
            },
            complete: (_id, bundleHash) => {
                terminal.push(`complete:${bundleHash}`);

                return Promise.resolve();
            },
            execute: async (_source, _rootDirectory, onLine) => {
                await onLine("compiling");

                return { bundle: "AA==", bundleHash: "hash-1" };
            },
            fail: (_id, error) => {
                terminal.push(`fail:${error}`);

                return Promise.resolve();
            },
            fetchSource: () => Promise.resolve(new ArrayBuffer(4)),
            ...overrides,
        };

        return { logs, ports, terminal };
    };

    it("streams logs and completes with the bundle hash", async () => {
        const { logs, ports, terminal } = portsWith({});
        const outcome = await runBuild(build, ports);

        expect(outcome).toStrictEqual({ bundleHash: "hash-1", status: "successful" });
        expect(terminal).toStrictEqual(["complete:hash-1"]);
        expect(logs).toContain("info:compiling");
    });

    it("fails the build when the source fetch throws — never completes", async () => {
        const { ports, terminal } = portsWith({ fetchSource: () => Promise.reject(new Error("tarball 404")) });
        const outcome = await runBuild(build, ports);

        expect(outcome).toStrictEqual({ error: "tarball 404", status: "failed" });
        expect(terminal).toStrictEqual(["fail:tarball 404"]);
    });

    it("hands the build to the release port, then completes it linked to the deployment", async () => {
        const order: string[] = [];
        const { logs, ports } = portsWith({
            complete: (_id, bundleHash, deploymentId) => {
                order.push(`complete:${bundleHash}:${deploymentId ?? "-"}`);

                return Promise.resolve();
            },
            release: async (_build, execution) => {
                order.push(`release:${execution.bundleHash}`);

                return { deploymentId: "dep_9", kind: "production", url: "https://app.lunora.app" };
            },
        });
        const outcome = await runBuild(build, ports);

        expect(outcome).toStrictEqual({ bundleHash: "hash-1", deploymentId: "dep_9", status: "successful" });
        // Released while the lease is still held — completing drops it, and the
        // release's lines are written under it.
        expect(order).toStrictEqual(["release:hash-1", "complete:hash-1:dep_9"]);
        expect(logs).toContain("info:released as deployment dep_9");
    });

    it("reports a production release as production, linking its URL", async () => {
        const statuses: string[] = [];
        const { ports } = portsWith({
            release: () => Promise.resolve({ deploymentId: "dep_9", kind: "production", url: "https://app.lunora.app" }),
            reportStatus: (_build, state, description, targetUrl) => {
                statuses.push(`${state}:${description}:${targetUrl ?? "-"}`);

                return Promise.resolve();
            },
        });

        await runBuild(build, ports);

        expect(statuses.at(-1)).toBe("success:Deployed to production on Lunora Cloud.:https://app.lunora.app");
    });

    it("keeps the build successful when the release throws — the artifact stays reusable", async () => {
        const statuses: string[] = [];
        const { logs, ports, terminal } = portsWith({
            release: () => Promise.reject(new Error("health check failed")),
            reportStatus: (_build, state, description) => {
                statuses.push(`${state}:${description}`);

                return Promise.resolve();
            },
        });
        const outcome = await runBuild(build, ports);

        expect(outcome).toStrictEqual({ bundleHash: "hash-1", status: "successful" });
        expect(terminal).toStrictEqual(["complete:hash-1"]);
        expect(logs).toContain("error:release failed: health check failed");
        // The commit must not read green: nothing was deployed.
        expect(statuses.at(-1)).toBe("failure:Build succeeded but the release failed: health check failed");
    });

    it("keeps the build successful, linked, when its deployment was recorded but failed", async () => {
        const statuses: string[] = [];
        const linked: (string | undefined)[] = [];
        const { logs, ports } = portsWith({
            complete: (_id, _hash, deploymentId) => {
                linked.push(deploymentId);

                return Promise.resolve();
            },
            release: () => Promise.resolve({ deploymentId: "dep_9", error: "health check failed", kind: "preview", url: "https://x.lunora.app" }),
            reportStatus: (_build, state, description, targetUrl) => {
                statuses.push(`${state}:${description}:${targetUrl ?? "-"}`);

                return Promise.resolve();
            },
        });
        const outcome = await runBuild(build, ports);

        expect(outcome).toStrictEqual({ bundleHash: "hash-1", deploymentId: "dep_9", status: "successful" });
        expect(linked).toStrictEqual(["dep_9"]);
        expect(logs).toContain("error:release failed: deployment dep_9 ended failed: health check failed");
        expect(statuses.at(-1)).toBe("failure:Build succeeded but the release failed: health check failed:https://x.lunora.app");
    });

    it("writes the release line before completing, so the lease still covers it", async () => {
        const order: string[] = [];
        const { ports } = portsWith({
            appendLog: (_id, _level, line) => {
                order.push(`log:${line}`);

                return Promise.resolve();
            },
            complete: () => {
                order.push("complete");

                return Promise.resolve();
            },
            release: () => Promise.resolve({ deploymentId: "dep_9", kind: "preview" }),
        });

        await runBuild(build, ports);

        expect(order.indexOf("log:released as deployment dep_9")).toBeLessThan(order.indexOf("complete"));
    });

    it("fails the build when execution throws", async () => {
        const { ports, terminal } = portsWith({
            execute: () => Promise.reject(new Error("compile error")),
        });
        const outcome = await runBuild(build, ports);

        expect(outcome.status).toBe("failed");
        expect(terminal).toStrictEqual(["fail:compile error"]);
    });
});
