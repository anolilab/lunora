import { describe, expect, it, vi } from "vitest";

import { advisories as buildAdvisories, listByProject, recordAdvisory, reusableRelease } from "../lunora/builds";
import { executeInContainer } from "../src/builds/container-exec";
import { runBuildStage } from "../src/builds/control-plane";
import type { BuildAdvisory, BuildRunnerPorts } from "../src/builds/runner";
import { MAX_BUILD_ADVISORIES } from "../src/builds/runner";
import type { BuildJob } from "../src/builds/runner-job";
import type { DeployHandlerDeps } from "../src/deploy/release-core";
import type { RouterEnv } from "../src/deploy/routes/shared";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import runBuild from "./support/run-build";

/**
 * The build box's bundle-scan findings on the control plane: read off the
 * NDJSON, stored on the build row under its lease, carried over when a build
 * re-releases an earlier one — and never able to change a build's outcome.
 */

const advisory = (over: Partial<BuildAdvisory> = {}): BuildAdvisory => {
    return {
        cacheKey: "alarm_always_rearms:src/room.ts:12",
        detail: "`alarm()` calls `storage.setAlarm(…)` at src/room.ts:12 on every run",
        file: "src/room.ts",
        level: "WARN",
        line: 12,
        location: "source",
        name: "alarm_always_rearms",
        remediation: "Re-arm only while work remains.",
        title: "Alarm re-arms itself almost immediately",
        ...over,
    };
};

/** A build box reply of exactly these NDJSON records. */
const replying = (records: ReadonlyArray<unknown>): { fetch: () => Promise<Response> } => {
    return { fetch: async () => new Response(records.map((record) => `${JSON.stringify(record)}\n`).join(""), { status: 200 }) };
};

const RELEASE = { bundle: "QQ==", bundleHash: "h1", manifest: { bindings: [] } };

describe("executeInContainer advisory records", () => {
    it("hands each advisory to onAdvisory, not to the log, and keeps it off the execution", async () => {
        expect.assertions(3);

        const onLine = vi.fn<(line: string) => Promise<void>>().mockResolvedValue();
        const onAdvisory = vi.fn<(advisory: BuildAdvisory) => Promise<void>>().mockResolvedValue();

        const execution = await executeInContainer(
            replying([{ advisory: advisory() }, { line: "warning: Alarm re-arms itself almost immediately" }, RELEASE]),
            new ArrayBuffer(1),
            undefined,
            onLine,
            onAdvisory,
        );

        expect(onAdvisory.mock.calls).toStrictEqual([[advisory()]]);
        expect(onLine.mock.calls).toStrictEqual([["warning: Alarm re-arms itself almost immediately"]]);
        expect(execution).toStrictEqual(RELEASE);
    });

    it.each([
        ["a missing field", { ...advisory(), title: undefined }],
        ["an empty field", advisory({ file: "" })],
        ["a line that is not a positive integer", advisory({ line: 0 })],
        ["a fractional line", advisory({ line: 1.5 })],
        ["a name that is not a detector's", advisory({ name: "<script>" })],
        ["a non-object", "alarm_always_rearms"],
    ])("drops a record with %s", async (_label, record) => {
        expect.assertions(1);

        const onAdvisory = vi.fn<(advisory: BuildAdvisory) => Promise<void>>().mockResolvedValue();

        await executeInContainer(replying([{ advisory: record }, RELEASE]), new ArrayBuffer(1), undefined, vi.fn().mockResolvedValue(undefined), onAdvisory);

        expect(onAdvisory).not.toHaveBeenCalled();
    });

    it("bounds every field, forces the level to WARN and drops an unknown location — the box ran tenant code", async () => {
        expect.assertions(1);

        const onAdvisory = vi.fn<(advisory: BuildAdvisory) => Promise<void>>().mockResolvedValue();

        await executeInContainer(
            replying([{ advisory: { ...advisory({ detail: "d".repeat(5000) }), extra: "ignored", level: "ERROR", location: "elsewhere" } }, RELEASE]),
            new ArrayBuffer(1),
            undefined,
            vi.fn().mockResolvedValue(undefined),
            onAdvisory,
        );

        const withoutLocation = Object.fromEntries(Object.entries(advisory()).filter(([key]) => key !== "location"));

        expect(onAdvisory.mock.calls[0]?.[0]).toStrictEqual({ ...withoutLocation, detail: "d".repeat(2000) });
    });

    it("keeps an INFO finding's level", async () => {
        expect.assertions(1);

        const onAdvisory = vi.fn<(advisory: BuildAdvisory) => Promise<void>>().mockResolvedValue();

        await executeInContainer(
            replying([{ advisory: advisory({ level: "INFO" }) }, RELEASE]),
            new ArrayBuffer(1),
            undefined,
            vi.fn().mockResolvedValue(undefined),
            onAdvisory,
        );

        expect(onAdvisory.mock.calls[0]?.[0]?.level).toBe("INFO");
    });

    it("caps a log line before it reaches buildLogs", async () => {
        expect.assertions(1);

        const onLine = vi.fn<(line: string) => Promise<void>>().mockResolvedValue();

        await executeInContainer(replying([{ line: "x".repeat(400_000) }, RELEASE]), new ArrayBuffer(1), undefined, onLine);

        expect(onLine.mock.calls[0]?.[0]).toHaveLength(8000);
    });

    it(`forwards at most ${String(MAX_BUILD_ADVISORIES)} advisories however many the box sends`, async () => {
        expect.assertions(1);

        const onAdvisory = vi.fn<(advisory: BuildAdvisory) => Promise<void>>().mockResolvedValue();
        const records = Array.from({ length: MAX_BUILD_ADVISORIES + 7 }, (_, index) => {
            return { advisory: advisory({ cacheKey: `k${String(index)}` }) };
        });

        await executeInContainer(replying([...records, RELEASE]), new ArrayBuffer(1), undefined, vi.fn().mockResolvedValue(undefined), onAdvisory);

        expect(onAdvisory).toHaveBeenCalledTimes(MAX_BUILD_ADVISORIES);
    });
});

describe("the runner and advisories", () => {
    const build = { buildId: "b1", commitSha: "abc", projectId: "p1" }; // secret-scanner:allow -- domain field name

    const portsWith = (overrides: Partial<BuildRunnerPorts>): { ports: BuildRunnerPorts; recorded: [string, BuildAdvisory][] } => {
        const recorded: [string, BuildAdvisory][] = [];
        const ports: BuildRunnerPorts = {
            appendLog: () => Promise.resolve(),
            complete: () => Promise.resolve(),
            execute: async (_source, _rootDirectory, _onLine, onAdvisory) => {
                await onAdvisory(advisory());

                return { bundle: "AA==", bundleHash: "hash-1" };
            },
            fail: () => Promise.resolve(),
            fetchSource: () => Promise.resolve(new ArrayBuffer(4)),
            recordAdvisory: (buildId, finding) => {
                recorded.push([buildId, finding]);

                return Promise.resolve();
            },
            ...overrides,
        };

        return { ports, recorded };
    };

    it("records each finding the build streams against its build", async () => {
        expect.assertions(2);

        const { ports, recorded } = portsWith({});

        await expect(runBuild(build, ports)).resolves.toStrictEqual({ bundleHash: "hash-1", status: "successful" });
        expect(recorded).toStrictEqual([["b1", advisory()]]);
    });

    it.each([
        ["rejects", () => Promise.reject(new Error("lease lost"))],
        [
            "throws synchronously",
            () => {
                throw new Error("lease lost");
            },
        ],
    ])("still succeeds when storing a finding %s — a warning never changes the outcome", async (_label, recordAdvisoryPort) => {
        expect.assertions(1);

        const { ports } = portsWith({ recordAdvisory: recordAdvisoryPort });

        await expect(runBuild(build, ports)).resolves.toStrictEqual({ bundleHash: "hash-1", status: "successful" });
    });

    it("carries the earlier build's findings over when it re-releases that build's stored release", async () => {
        expect.assertions(2);

        const carried = [advisory(), advisory({ cacheKey: "unbounded_loop:src/a.ts:3", line: 3, name: "unbounded_loop" })];
        const { ports, recorded } = portsWith({
            execute: () => Promise.reject(new Error("must not build")),
            fetchSource: () => Promise.reject(new Error("must not fetch")),
            storedRelease: () => Promise.resolve({ advisories: carried, deploymentId: "dep_old", execution: { bundle: "BB==", bundleHash: "hash-old" } }),
        });

        await expect(runBuild(build, ports)).resolves.toStrictEqual({ bundleHash: "hash-old", status: "successful" });
        expect(recorded).toStrictEqual(carried.map((finding) => ["b1", finding]));
    });

    it("does not carry findings over when the stored release was pruned and the build runs again", async () => {
        expect.assertions(1);

        const { ports, recorded } = portsWith({
            storedRelease: () => Promise.resolve({ advisories: [advisory({ cacheKey: "stale" })], deploymentId: "dep_old", execution: null }),
        });

        await runBuild(build, ports);

        // Only what the fresh build found.
        expect(recorded.map(([, finding]) => finding.cacheKey)).toStrictEqual([advisory().cacheKey]);
    });
});

describe("runBuildStage carry-over", () => {
    const job: BuildJob = { build: { buildId: "bld_1", commitSha: "abc", projectId: "prj_1" }, runnerId: "edge-1" }; // secret-scanner:allow -- domain field name

    it("stores the re-released build's findings under the new build's lease", async () => {
        expect.assertions(1);

        const mutations: Record<string, unknown>[] = [];
        const context = {
            runAction: () => Promise.reject(new Error("unused")),
            runMutation: <R>(_reference: unknown, args: Record<string, unknown> = {}) => {
                mutations.push(args);

                return Promise.resolve(undefined as R);
            },
            runQuery: <R>() => Promise.resolve({ advisories: [advisory()], bundleHash: "h1", deploymentId: "dep_old" } as R),
        } as NonNullable<RouterEnv["__lunoraCtx"]>;
        const objects = new Map<string, string>();
        const bucket = {
            delete: () => Promise.resolve(),
            get: () => Promise.resolve(null),
            put: (key: string, value: string) => Promise.resolve(objects.set(key, value)),
        };
        const deploy = { releases: { get: () => Promise.resolve({ bundle: "QUJD", manifest: { bindings: [] } }) } } as unknown as DeployHandlerDeps;

        await runBuildStage({ context, deploy, environment: { RELEASES: bucket } }, job, "build");

        expect(mutations.filter((args) => "advisory" in args)).toStrictEqual([{ advisory: advisory(), buildId: "bld_1", runnerId: "edge-1" }]);
    });
});

describe("builds.recordAdvisory", () => {
    const claimed = (over: Row = {}): Row => {
        return { _id: "bld_1", organizationId: "org_1", processingBy: "runner_1", projectId: "prj_1", ...over };
    };
    const args = { advisory: advisory(), buildId: "bld_1" as never, runnerId: "runner_1" };

    it("appends the finding to the build row", async () => {
        expect.assertions(1);

        const { ctx, ops } = makeCtx({ builds: [claimed({ advisories: [advisory({ cacheKey: "earlier" })] })] });

        await recordAdvisory.handler(ctx, args);

        expect(ops).toStrictEqual([{ id: "bld_1", kind: "patch", patch: { advisories: [advisory({ cacheKey: "earlier" }), advisory()] } }]);
    });

    it("refuses a runner that does not hold the build's lease", async () => {
        expect.assertions(2);

        const { ctx, ops } = makeCtx({ builds: [claimed({ processingBy: "runner_2" })] });

        await expect(recordAdvisory.handler(ctx, args)).rejects.toThrow(/lease is held by another runner/u);
        expect(ops).toStrictEqual([]);
    });

    it.each([
        ["one with the same cache key is already stored", [advisory()]],
        [
            `${String(MAX_BUILD_ADVISORIES)} are already stored`,
            Array.from({ length: MAX_BUILD_ADVISORIES }, (_, index) => advisory({ cacheKey: `k${String(index)}` })),
        ],
    ])("writes nothing when %s", async (_label, existing) => {
        expect.assertions(1);

        const { ctx, ops } = makeCtx({ builds: [claimed({ advisories: existing })] });

        await recordAdvisory.handler(ctx, args);

        expect(ops).toStrictEqual([]);
    });
});

describe("builds.reusableRelease advisories", () => {
    const rows = (earlier: Row): Record<string, Row[]> => {
        return {
            builds: [
                { _id: "bld_new", projectId: "prj_1", reusesBuildId: "bld_old" },
                { _id: "bld_old", bundleHash: "h1", deploymentId: "dep_old", projectId: "prj_1", ...earlier },
            ],
            deployments: [{ _id: "dep_old", projectId: "prj_1" }],
        };
    };

    it("returns the earlier build's findings with its release", async () => {
        expect.assertions(1);

        const { ctx } = makeCtx(rows({ advisories: [advisory()] }));

        await expect(reusableRelease.handler(ctx, { buildId: "bld_new" as never })).resolves.toStrictEqual({
            advisories: [advisory()],
            bundleHash: "h1",
            deploymentId: "dep_old",
        });
    });

    it("leaves the key out when the earlier build had none", async () => {
        expect.assertions(1);

        const { ctx } = makeCtx(rows({}));

        await expect(reusableRelease.handler(ctx, { buildId: "bld_new" as never })).resolves.toStrictEqual({ bundleHash: "h1", deploymentId: "dep_old" });
    });
});

describe("reading advisories in the studio", () => {
    const rows = (): Record<string, Row[]> => {
        return {
            builds: [
                {
                    _id: "bld_1",
                    advisories: [advisory({ cacheKey: "note", level: "INFO" }), advisory(), advisory({ cacheKey: "loop", name: "unbounded_loop" })],
                    createdAt: 2,
                    organizationId: "org_1",
                    projectId: "prj_1",
                },
                { _id: "bld_2", createdAt: 1, organizationId: "org_1", projectId: "prj_1" },
                { _id: "bld_other", advisories: [advisory()], createdAt: 3, organizationId: "org_2", projectId: "prj_9" },
            ],
            members: [owner("org_1")],
        };
    };

    it("lists builds with counts, not the findings themselves", async () => {
        expect.assertions(2);

        const { ctx } = makeCtx(rows());
        const listed = await listByProject.handler(ctx, { organizationId: "org_1" as never, projectId: "prj_1" as never });

        expect(listed.map(({ _id, advisoryNotes, advisoryWarnings }) => [_id, advisoryWarnings, advisoryNotes])).toStrictEqual([
            ["bld_1", 2, 1],
            ["bld_2", 0, 0],
        ]);
        expect(listed.some((row) => "advisories" in row)).toBe(false);
    });

    it("loads one build's findings, warnings first", async () => {
        expect.assertions(1);

        const { ctx } = makeCtx(rows());

        await expect(buildAdvisories.handler(ctx, { buildId: "bld_1" as never, organizationId: "org_1" as never })).resolves.toMatchObject([
            { level: "WARN" },
            { level: "WARN" },
            { level: "INFO" },
        ]);
    });

    it("refuses another organization's build", async () => {
        expect.assertions(1);

        const { ctx } = makeCtx(rows());

        await expect(buildAdvisories.handler(ctx, { buildId: "bld_other" as never, organizationId: "org_1" as never })).rejects.toThrow(
            /not found in this organization/u,
        );
    });
});
