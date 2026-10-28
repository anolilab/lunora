import { describe, expect, it } from "vitest";

import type { PauseStatus } from "../../src/commands/pause/handler";
import { runPauseCommand } from "../../src/commands/pause/handler";
import type { FetchLike } from "../../src/commands/run/handler";
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

/** A worker whose pause route answers `result`, recording each request. */
const pauseFetch =
    (result: PauseStatus, calls: { body: unknown; method: string; url: string }[], status = 200): FetchLike =>
    async (url, init) => {
        calls.push({ body: init?.body === undefined ? undefined : JSON.parse(init.body), method: init?.method ?? "GET", url });

        return {
            json: async () => result,
            ok: status < 300,
            status,
            text: async () => JSON.stringify(result),
        };
    };

const TARGET = { token: "t", url: "http://localhost:8787" };

describe("lunora pause / resume", () => {
    it("pauses with a reason and reports the new state", async () => {
        expect.assertions(3);

        const calls: { body: unknown; method: string; url: string }[] = [];
        const { lines, logger } = capturingLogger();
        const result = await runPauseCommand({
            ...TARGET,
            action: "pause",
            fetchImpl: pauseFetch({ paused: true, pausedAt: 0, reason: "incident 42", supported: true }, calls),
            logger,
            reason: "incident 42",
        });

        expect(result.code).toBe(0);
        expect(calls).toStrictEqual([{ body: { paused: true, reason: "incident 42" }, method: "POST", url: "http://localhost:8787/_lunora/admin/pause" }]);
        expect(lines).toContain("success http://localhost:8787: paused since 1970-01-01T00:00:00.000Z — incident 42");
    });

    it("resumes", async () => {
        expect.assertions(2);

        const calls: { body: unknown; method: string; url: string }[] = [];
        const { lines, logger } = capturingLogger();

        await runPauseCommand({ ...TARGET, action: "resume", fetchImpl: pauseFetch({ paused: false, supported: true }, calls), logger });

        expect(calls[0]).toMatchObject({ body: { paused: false }, method: "POST" });
        expect(lines).toContain("success http://localhost:8787: running");
    });

    it("reads the state with GET for status", async () => {
        expect.assertions(2);

        const calls: { body: unknown; method: string; url: string }[] = [];
        const { lines, logger } = capturingLogger();

        await runPauseCommand({ ...TARGET, action: "status", fetchImpl: pauseFetch({ paused: false, supported: true }, calls), logger });

        expect(calls[0]).toMatchObject({ body: undefined, method: "GET" });
        expect(lines).toContain("info running");
    });

    it("warns when the deployment cannot be paused, and fails on a refused request", async () => {
        expect.assertions(3);

        const unsupported = capturingLogger();

        await runPauseCommand({ ...TARGET, action: "status", fetchImpl: pauseFetch({ paused: false, supported: false }, []), logger: unsupported.logger });

        expect(unsupported.lines).toContain("warn this deployment has no scheduler, so it cannot be paused");

        const refused = await runPauseCommand({
            ...TARGET,
            action: "pause",
            fetchImpl: pauseFetch({ paused: false, supported: false }, [], 400),
            logger: capturingLogger().logger,
        });

        expect(refused.code).not.toBe(0);
        expect(refused.error).toContain("HTTP 400");
    });

    it("refuses --prod without an explicit --url", async () => {
        expect.assertions(1);

        const result = await runPauseCommand({ action: "pause", logger: capturingLogger().logger, prod: true });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });
});
