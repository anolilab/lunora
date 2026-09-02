import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FetchLike, FunctionStatRow } from "../../src/commands/insights/handler";
import { buildInsightsReport, formatInsightsReport, runInsightsCommand } from "../../src/commands/insights/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

/** A complete stats row with sensible defaults; spread overrides over it per case. */
const statRow = (overrides: Partial<FunctionStatRow> & Pick<FunctionStatRow, "path">): FunctionStatRow => {
    return {
        calls: 0,
        conflicts: 0,
        errors: 0,
        lastErrorMessage: null,
        maxDurationMs: 0,
        totalDurationMs: 0,
        ...overrides,
    };
};

/** A fetch that records its calls and replies with a JSON `getFunctionStats` envelope. */
const statsFetch =
    (functions: FunctionStatRow[], calls: { body: unknown; headers?: Record<string, string>; url: string }[]): FetchLike =>
    async (url, init) => {
        calls.push({ body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers, url });

        return {
            json: async () => {
                return { functions, sinceMs: 0 };
            },
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ functions, sinceMs: 0 }),
        };
    };

describe("buildInsightsReport", () => {
    it("ranks write-conflict hot-spots by conflict rate, conflicts being a subset of errors", () => {
        expect.assertions(4);

        const report = buildInsightsReport(
            [
                statRow({ calls: 100, conflicts: 30, errors: 30, path: "rooms:bump" }),
                statRow({ calls: 100, conflicts: 5, errors: 5, path: "users:touch" }),
                statRow({ calls: 100, conflicts: 0, errors: 12, path: "users:create" }),
            ],
            10,
        );

        // users:create has errors but no conflicts → excluded from write contention.
        expect(report.writeContention.map((row) => row.path)).toEqual(["rooms:bump", "users:touch"]);
        expect(report.writeContention[0]?.rate).toBeCloseTo(0.3);
        // It is still an error hot-spot, ranked by error rate.
        expect(report.errorHotspots.map((row) => row.path)).toEqual(["rooms:bump", "users:create", "users:touch"]);
        expect(report.totalFunctions).toBe(3);
    });

    it("ranks latency outliers by slowest single call and computes the mean", () => {
        expect.assertions(2);

        const report = buildInsightsReport(
            [
                statRow({ calls: 2, maxDurationMs: 50, path: "fast:fn", totalDurationMs: 60 }),
                statRow({ calls: 4, maxDurationMs: 900, path: "slow:fn", totalDurationMs: 1200 }),
            ],
            10,
        );

        expect(report.latencyOutliers.map((row) => row.path)).toEqual(["slow:fn", "fast:fn"]);
        expect(report.latencyOutliers[0]?.meanDurationMs).toBeCloseTo(300);
    });

    it("treats a missing `conflicts` field (pre-tracking worker) as zero", () => {
        expect.assertions(1);

        const report = buildInsightsReport([{ calls: 10, errors: 2, lastErrorMessage: null, maxDurationMs: 5, path: "legacy:fn", totalDurationMs: 20 }], 10);

        expect(report.writeContention).toHaveLength(0);
    });

    it("caps each section at the limit", () => {
        expect.assertions(1);

        const functions = Array.from({ length: 5 }, (_, index) => statRow({ calls: 10, conflicts: index + 1, errors: index + 1, path: `fn:${String(index)}` }));

        const report = buildInsightsReport(functions, 2);

        expect(report.writeContention).toHaveLength(2);
    });
});

describe("formatInsightsReport", () => {
    it("renders the empty state when nothing contended or failed", () => {
        expect.assertions(2);

        const text = formatInsightsReport(buildInsightsReport([statRow({ calls: 3, maxDurationMs: 5, path: "ok:fn", totalDurationMs: 9 })], 10));

        expect(text).toContain("none — no write conflicts observed");
        expect(text).toContain("none — no errors observed");
    });

    it("lists a conflicted function with its rate", () => {
        expect.assertions(1);

        const text = formatInsightsReport(buildInsightsReport([statRow({ calls: 100, conflicts: 30, errors: 30, path: "rooms:bump" })], 10));

        expect(text).toContain("rooms:bump  30/100 calls (30.0%)");
    });
});

describe("runInsightsCommand", () => {
    let savedToken: string | undefined;
    let workdir: string;

    beforeEach(() => {
        savedToken = process.env.LUNORA_ADMIN_TOKEN;
        delete process.env.LUNORA_ADMIN_TOKEN;
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-insights-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });

        if (savedToken === undefined) {
            delete process.env.LUNORA_ADMIN_TOKEN;
        } else {
            process.env.LUNORA_ADMIN_TOKEN = savedToken;
        }
    });

    it("fails without an admin token", async () => {
        expect.assertions(1);

        const result = await runInsightsCommand({ cwd: workdir, logger: silentLogger(), url: "http://localhost:8787" });

        expect(result.code).toBe(1);
    });

    it("falls back to the .dev.vars token against a local worker", async () => {
        expect.assertions(2);

        writeFileSync(join(workdir, ".dev.vars"), "LUNORA_ADMIN_TOKEN=from-dev-vars\n", "utf8");

        const calls: { body: unknown; headers?: Record<string, string>; url: string }[] = [];

        const result = await runInsightsCommand({
            cwd: workdir,
            fetchImpl: statsFetch([], calls),
            logger: silentLogger(),
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(0);
        expect(calls[0]?.headers?.authorization).toBe("Bearer from-dev-vars");
    });

    it("refuses --prod without an explicit --url", async () => {
        expect.assertions(1);

        const result = await runInsightsCommand({ logger: silentLogger(), prod: true, token: "secret" });

        expect(result.code).toBe(1);
    });

    it("pOSTs the admin RPC with the bearer token and returns the report", async () => {
        expect.assertions(4);

        const calls: { body: unknown; headers?: Record<string, string>; url: string }[] = [];
        const fetchImpl = statsFetch([statRow({ calls: 100, conflicts: 40, errors: 40, path: "rooms:bump" })], calls);

        const result = await runInsightsCommand({
            fetchImpl,
            logger: silentLogger(),
            token: "secret",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(0);
        expect(calls[0]?.url).toBe("http://localhost:8787/_lunora/rpc");
        expect(calls[0]?.headers?.authorization).toBe("Bearer secret");
        expect((calls[0]?.body as { functionPath?: string }).functionPath).toBe("__lunora_admin__:getFunctionStats");
    });

    it("forwards --shard as the shardKey", async () => {
        expect.assertions(1);

        const calls: { body: unknown; url: string }[] = [];
        const fetchImpl = statsFetch([], calls);

        await runInsightsCommand({ fetchImpl, logger: silentLogger(), shard: "channel:42", token: "secret" });

        expect((calls[0]?.body as { shardKey?: string }).shardKey).toBe("channel:42");
    });

    it("unwraps a `{ result }` runner envelope", async () => {
        expect.assertions(1);

        const fetchImpl: FetchLike = async () => {
            const payload = { result: { functions: [statRow({ calls: 10, conflicts: 2, errors: 2, path: "wrapped:fn" })], sinceMs: 0 } };

            return { json: async () => payload, ok: true, status: 200, text: async () => JSON.stringify(payload) };
        };

        const result = await runInsightsCommand({ fetchImpl, logger: silentLogger(), token: "secret" });

        expect(result.report?.writeContention[0]?.path).toBe("wrapped:fn");
    });

    it("returns non-zero on an HTTP error", async () => {
        expect.assertions(1);

        const fetchImpl: FetchLike = async () => {
            return {
                json: async () => {
                    return {};
                },
                ok: false,
                status: 403,
                text: async () => "forbidden",
            };
        };

        const result = await runInsightsCommand({ fetchImpl, logger: silentLogger(), token: "secret" });

        expect(result.code).toBe(1);
    });
});
