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

        expect(intent).toStrictEqual({ branch: "main", commitSha: "abc123", installationId: 42, repository: "acme/app" });
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
            execute: async (_source, onLine) => {
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

    it("hands a completed build to the release port and reports the deployment", async () => {
        const { logs, ports } = portsWith({ release: () => Promise.resolve({ deploymentId: "dep_9" }) });
        const outcome = await runBuild(build, ports);

        expect(outcome).toStrictEqual({ bundleHash: "hash-1", deploymentId: "dep_9", status: "successful" });
        expect(logs).toContain("info:released as deployment dep_9");
    });

    it("keeps the build successful when the release fails — the artifact stays reusable", async () => {
        const { logs, ports, terminal } = portsWith({ release: () => Promise.reject(new Error("health check failed")) });
        const outcome = await runBuild(build, ports);

        expect(outcome).toStrictEqual({ bundleHash: "hash-1", status: "successful" });
        expect(terminal).toStrictEqual(["complete:hash-1"]);
        expect(logs).toContain("error:release failed: health check failed");
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
