import { describe, expect, it } from "vitest";

import type { FetchLike } from "../../src/commands/run/handler";
import type { ShardRegistryPruneResult } from "../../src/commands/shards/handler";
import { runShardsCommand } from "../../src/commands/shards/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];

    return {
        lines,
        logger: {
            error: (message: string) => lines.push(`error ${message}`),
            info: (message: string) => lines.push(`info ${message}`),
            success: (message: string) => lines.push(`success ${message}`),
            warn: (message: string) => lines.push(`warn ${message}`),
        },
    };
};

/** A worker whose prune route answers `result` with `status`, recording what it was sent. */
const pruneFetch =
    (result: ShardRegistryPruneResult, status: number, calls: { body: unknown; url: string }[]): FetchLike =>
    async (url, init) => {
        calls.push({ body: JSON.parse(init?.body ?? "{}"), url });

        return {
            json: async () => result,
            ok: status < 300,
            status,
            text: async () => JSON.stringify(result),
        };
    };

const RESULT: ShardRegistryPruneResult = {
    failed: [],
    kept: [{ shardKey: "c1", table: "messages" }],
    released: [{ shardKey: "c2", table: "messages" }],
};

describe("lunora shards prune", () => {
    it("posts the prune with the named tables and dry-run flag, and reports what it released", async () => {
        expect.assertions(4);

        const calls: { body: unknown; url: string }[] = [];
        const { lines, logger } = capturingLogger();

        const result = await runShardsCommand({
            dryRun: true,
            fetchImpl: pruneFetch(RESULT, 200, calls),
            logger,
            subcommand: "prune",
            tables: "messages, threads",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(0);
        expect(calls).toStrictEqual([
            { body: { dryRun: true, tables: ["messages", "threads"] }, url: "http://localhost:8787/_lunora/admin/shard-registry/prune" },
        ]);
        expect(lines).toContain("info would release c2 (messages)");
        expect(lines).toContain("success 1 would be released, 1 kept (still hold rows), 0 unreachable");
    });

    it("exits non-zero when a shard could not be checked (the route's 207)", async () => {
        expect.assertions(2);

        const { lines, logger } = capturingLogger();

        const result = await runShardsCommand({
            fetchImpl: pruneFetch({ ...RESULT, failed: [{ message: "timed out", shardKey: "c3", tables: ["messages"] }] }, 207, []),
            logger,
            subcommand: "prune",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).toBe(1);
        expect(lines).toContain("error could not check c3 (messages) — kept: timed out");
    });

    it("surfaces the worker's refusal", async () => {
        expect.assertions(1);

        const result = await runShardsCommand({
            fetchImpl: pruneFetch(RESULT, 400, []),
            logger: capturingLogger().logger,
            subcommand: "prune",
            token: "t",
            url: "http://localhost:8787",
        });

        expect(result.code).not.toBe(0);
    });

    it("rejects an unknown subcommand", async () => {
        expect.assertions(1);

        const result = await runShardsCommand({ logger: capturingLogger().logger, subcommand: "list", token: "t", url: "http://localhost:8787" });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });
});
