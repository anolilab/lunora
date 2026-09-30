import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AiGatewayData } from "../../src/commands/ai/handler";
import { execute, runAiCommand } from "../../src/commands/ai/handler";
import type { AiOptions } from "../../src/commands/ai/index";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import { runExecute } from "../helpers/execute";

const recordingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (prefix: string) =>
        (message: string): number =>
            lines.push(`${prefix}${message}`);

    return { lines, logger: { error: push("error: "), info: push("info: "), success: push("success: "), warn: push("warn: ") } };
};

/** A wrangler.jsonc with a comment, so the edit is checked to preserve it. */
const WRANGLER = `{
    // the worker
    "name": "demo-app",
    "vars": {
        "KEEP": "me", // untouched
    },
}
`;

const ENVIRONMENT = { CLOUDFLARE_ACCOUNT_ID: "acc123", CLOUDFLARE_API_TOKEN: "tok" };

interface RecordedCall {
    body: unknown;
    method: string;
    url: string;
}

/** A `fetch` double answering the gateway GET with `getStatus`, and the POST with 200. */
const fakeFetch = (getStatus: number, getResult: Record<string, unknown> = {}): { calls: RecordedCall[]; fetch: typeof globalThis.fetch } => {
    const calls: RecordedCall[] = [];
    const fetch = (async (input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";

        calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, method, url: input });

        if (method === "GET") {
            const ok = getStatus === 200;

            return Response.json(
                ok ? { errors: [], result: getResult, success: true } : { errors: [{ code: 7002, message: "not found" }], result: null, success: false },
                { status: getStatus },
            );
        }

        return Response.json({ errors: [], result: { id: "x" }, success: true }, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    return { calls, fetch };
};

const readVariables = (dir: string): Record<string, unknown> =>
    (parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as { vars: Record<string, unknown> }).vars;

let workdir: string;

describe("lunora ai gateway", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cli-ai-"));
        writeFileSync(join(workdir, "wrangler.jsonc"), WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("creates the gateway named after the worker and writes its vars, preserving comments", async () => {
        expect.assertions(7);

        const { calls, fetch } = fakeFetch(404);
        const { lines, logger } = recordingLogger();
        const result = await runAiCommand({ cwd: workdir, environment: ENVIRONMENT, fetch, logger, subcommand: "gateway" });

        expect(result.code).toBe(0);
        expect(calls.map((call) => `${call.method} ${call.url}`)).toStrictEqual([
            "GET https://api.cloudflare.com/client/v4/accounts/acc123/ai-gateway/gateways/demo-app",
            "POST https://api.cloudflare.com/client/v4/accounts/acc123/ai-gateway/gateways",
        ]);
        expect(calls[1]?.body).toStrictEqual({
            cache_invalidate_on_update: true,
            cache_ttl: 0,
            collect_logs: true,
            id: "demo-app",
            rate_limiting_interval: 0,
            rate_limiting_limit: 0,
        });
        expect(readVariables(workdir)).toStrictEqual({ KEEP: "me", LUNORA_AI_GATEWAY_ACCOUNT_ID: "acc123", LUNORA_AI_GATEWAY_ID: "demo-app" });

        const text = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

        expect(text).toContain("// the worker");
        expect(text).toContain("// untouched");
        expect(lines.join("\n")).toContain("unified-billing");
    });

    it("reuses an existing gateway and honours --id and --no-logs", async () => {
        expect.assertions(4);

        const { calls, fetch } = fakeFetch(200, { collect_logs: false, id: "shared" });
        const result = await runAiCommand({
            cwd: workdir,
            environment: ENVIRONMENT,
            fetch,
            id: "shared",
            logger: recordingLogger().logger,
            logs: false,
            subcommand: "gateway",
        });

        expect(result.code).toBe(0);
        expect(calls.map((call) => call.method)).toStrictEqual(["GET"]);
        expect(result.data?.action).toBe("existing");
        expect(readVariables(workdir)["LUNORA_AI_GATEWAY_ID"]).toBe("shared");
    });

    it("sends collect_logs: false on create with --no-logs", async () => {
        expect.assertions(1);

        const { calls, fetch } = fakeFetch(404);

        await runAiCommand({ cwd: workdir, environment: ENVIRONMENT, fetch, logger: recordingLogger().logger, logs: false, subcommand: "gateway" });

        expect((calls[1]?.body as { collect_logs: boolean }).collect_logs).toBe(false);
    });

    it("--dry-run neither calls Cloudflare nor edits the file", async () => {
        expect.assertions(5);

        const { calls, fetch } = fakeFetch(404);
        const { lines, logger } = recordingLogger();
        const result = await runAiCommand({ cwd: workdir, dryRun: true, environment: {}, fetch, logger, subcommand: "gateway" });

        expect(result.code).toBe(0);
        // The account id a real run needs is missing, so the plan says so up front.
        expect(lines.some((line) => line.startsWith("warn: ") && line.includes("CLOUDFLARE_ACCOUNT_ID"))).toBe(true);
        expect(calls).toHaveLength(0);
        expect(result.data?.varsWritten).toStrictEqual(["LUNORA_AI_GATEWAY_ID"]);
        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(WRANGLER);
    });

    it("takes the account id from wrangler.jsonc when CLOUDFLARE_ACCOUNT_ID is unset", async () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "wrangler.jsonc"), `{ "account_id": "from-config", "name": "demo-app" }`, "utf8");

        const { calls, fetch } = fakeFetch(404);
        const result = await runAiCommand({
            cwd: workdir,
            environment: { CLOUDFLARE_API_TOKEN: "tok" },
            fetch,
            logger: recordingLogger().logger,
            subcommand: "gateway",
        });

        expect(result.code).toBe(0);
        expect(calls[0]?.url).toContain("/accounts/from-config/");
    });

    it("refuses without credentials, before any request", async () => {
        expect.assertions(3);

        const { calls, fetch } = fakeFetch(404);
        const result = await runAiCommand({ cwd: workdir, environment: {}, fetch, logger: recordingLogger().logger, subcommand: "gateway" });

        expect(result.code).toBe(EXIT_CODE.AUTH);
        expect(result.error).toContain("CLOUDFLARE_API_TOKEN");
        expect(calls).toHaveLength(0);
    });

    it("maps an API failure to its exit code and leaves the file alone", async () => {
        expect.assertions(3);

        const { fetch } = fakeFetch(403);
        const result = await runAiCommand({ cwd: workdir, environment: ENVIRONMENT, fetch, logger: recordingLogger().logger, subcommand: "gateway" });

        expect(result.code).toBe(EXIT_CODE.PERMISSION);
        expect(result.error).toContain("403");
        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toBe(WRANGLER);
    });

    it("rejects an unknown subcommand as bad usage", async () => {
        expect.assertions(1);

        const result = await runAiCommand({ cwd: workdir, logger: recordingLogger().logger, subcommand: "nope" });

        expect(result.code).toBe(EXIT_CODE.USAGE);
    });

    it("fails when there is no wrangler config", async () => {
        expect.assertions(1);

        rmSync(join(workdir, "wrangler.jsonc"));

        const result = await runAiCommand({ cwd: workdir, logger: recordingLogger().logger, subcommand: "gateway" });

        expect(result.code).toBe(EXIT_CODE.NOT_FOUND);
    });

    it("emits the --format json envelope from execute (dry run)", async () => {
        expect.assertions(3);

        const outcome = await runExecute<AiOptions, AiGatewayData>(execute, {
            argument: ["gateway"],
            commandName: "ai",
            cwd: workdir,
            options: { dryRun: true, format: "json" },
        });

        expect(outcome.code).toBe(0);
        expect(outcome.document?.data?.gatewayId).toBe("demo-app");
        expect(outcome.document?.data?.action).toBe("planned");
    });
});
