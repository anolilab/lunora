import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runProfileCommand } from "../../src/commands/cloudflare/profile/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";

const recordingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (prefix: string) =>
        (message: string): number =>
            lines.push(`${prefix}${message}`);

    return { lines, logger: { error: push("error: "), info: push("info: "), success: push("success: "), warn: push("warn: ") } };
};

const ENVIRONMENT = { CLOUDFLARE_ACCOUNT_ID: "acc123", CLOUDFLARE_API_TOKEN: "tok" };

/** Not valid UTF-8 and not JSON: what a gzip stream looks like, so a text/JSON read would corrupt or reject it. */
const GZIP_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x7b]);

interface RecordedCall {
    body: unknown;
    headers: Record<string, string>;
    method: string;
    url: string;
}

const fakeFetch = (respond: () => Response): { calls: RecordedCall[]; fetch: typeof globalThis.fetch } => {
    const calls: RecordedCall[] = [];
    const fetch = (async (input: string, init?: RequestInit) => {
        calls.push({
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
            headers: init?.headers as Record<string, string>,
            method: init?.method ?? "GET",
            url: input,
        });

        return respond();
    }) as unknown as typeof globalThis.fetch;

    return { calls, fetch };
};

describe("lunora cloudflare profile", () => {
    let cwd: string;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-cloudflare-profile-"));
        writeFileSync(join(cwd, "wrangler.jsonc"), `{ "name": "demo-app", "upload_source_maps": true }\n`, "utf8");
    });

    afterEach(() => {
        rmSync(cwd, { force: true, recursive: true });
    });

    it("pOSTs the capture request and writes the binary body to disk byte-for-byte", async () => {
        expect.assertions(7);

        const { calls, fetch } = fakeFetch(() => new Response(GZIP_BYTES, { status: 200 }));
        const { logger } = recordingLogger();
        const result = await runProfileCommand({ cwd, environment: ENVIRONMENT, fetch, logger, out: "p.pprof.gz" });

        expect(result.code).toBe(EXIT_CODE.SUCCESS);
        expect(calls[0]?.method).toBe("POST");
        expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/workers/workers/demo-app/versions/latest/profile");
        expect(calls[0]?.body).toStrictEqual({ duration_ms: 10_000, profile_type: "cpu" });
        expect(calls[0]?.headers["Authorization"]).toBe("Bearer tok");
        expect([...readFileSync(join(cwd, "p.pprof.gz"))]).toStrictEqual([...GZIP_BYTES]);
        expect(result.data?.bytes).toBe(GZIP_BYTES.byteLength);
    });

    it("sends heap type, duration, version, and Durable Object ids", async () => {
        expect.assertions(2);

        const actorId = "a".repeat(64);
        const { calls, fetch } = fakeFetch(() => new Response(GZIP_BYTES));
        const { logger } = recordingLogger();
        const result = await runProfileCommand({
            actorId,
            cwd,
            durationMs: "30000",
            environment: ENVIRONMENT,
            fetch,
            logger,
            namespaceId: "ns1",
            out: "h.gz",
            type: "heap",
            version: "v-1",
            worker: "other",
        });

        expect(result.code).toBe(EXIT_CODE.SUCCESS);
        expect(calls[0]).toMatchObject({
            body: { actor_id: actorId, duration_ms: 30_000, namespace_id: "ns1", profile_type: "heap" },
            url: "https://api.cloudflare.com/client/v4/accounts/acc123/workers/workers/other/versions/v-1/profile",
        });
    });

    it("targets <name>-<env> for a wrangler environment", async () => {
        expect.assertions(1);

        const { calls, fetch } = fakeFetch(() => new Response(GZIP_BYTES));

        await runProfileCommand({ cwd, env: "staging", environment: ENVIRONMENT, fetch, logger: recordingLogger().logger, out: "e.gz" });

        expect(calls[0]?.url).toContain("/workers/workers/demo-app-staging/");
    });

    it.each([
        [{ type: "memory" }, "invalid --type"],
        [{ durationMs: "999" }, "invalid --duration-ms"],
        [{ durationMs: "50001" }, "invalid --duration-ms"],
        [{ durationMs: "abc" }, "invalid --duration-ms"],
        [{ namespaceId: "ns" }, "together"],
        [{ actorId: "a".repeat(64) }, "together"],
        [{ actorId: "zz", namespaceId: "ns" }, "64-character"],
    ])("refuses bad input %j before any call", async (input, message) => {
        expect.assertions(3);

        const { calls, fetch } = fakeFetch(() => new Response(GZIP_BYTES));
        const result = await runProfileCommand({ cwd, environment: ENVIRONMENT, fetch, logger: recordingLogger().logger, ...input });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain(message);
        expect(calls).toHaveLength(0);
    });

    it("requires a token and an account", async () => {
        expect.assertions(2);

        const { logger } = recordingLogger();

        const noToken = await runProfileCommand({ cwd, environment: { CLOUDFLARE_ACCOUNT_ID: "a" }, logger });
        const noAccount = await runProfileCommand({ cwd, environment: { CLOUDFLARE_API_TOKEN: "t" }, logger });

        expect(noToken.code).toBe(EXIT_CODE.AUTH);
        expect(noAccount.code).toBe(EXIT_CODE.USAGE);
    });

    it.each([
        [403, EXIT_CODE.PERMISSION, "Workers Scripts Read"],
        [404, EXIT_CODE.NOT_FOUND, "namespace and actor"],
        [429, EXIT_CODE.RATE_LIMITED, "rate limited"],
    ])("maps HTTP %i to its exit code and writes no file", async (status, code, hint) => {
        expect.assertions(4);

        const { fetch } = fakeFetch(() =>
            Response.json({ errors: [{ message: "No recent executions were found for this Worker." }], success: false }, { status }),
        );
        const result = await runProfileCommand({ cwd, environment: ENVIRONMENT, fetch, logger: recordingLogger().logger, out: "x.gz" });

        expect(result.code).toBe(code);
        expect(result.error).toContain("No recent executions");
        expect(result.error).toContain(hint);
        expect(existsSync(join(cwd, "x.gz"))).toBe(false);
    });

    it("warns when source maps are not uploaded", async () => {
        expect.assertions(1);

        writeFileSync(join(cwd, "wrangler.jsonc"), `{ "name": "demo-app" }\n`, "utf8");

        const { fetch } = fakeFetch(() => new Response(GZIP_BYTES));
        const { lines, logger } = recordingLogger();

        await runProfileCommand({ cwd, environment: ENVIRONMENT, fetch, logger, out: "w.gz" });

        expect(lines.some((line) => line.startsWith("warn: ") && line.includes("upload_source_maps"))).toBe(true);
    });
});
