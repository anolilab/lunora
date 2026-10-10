import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProfileCommandOptions } from "../../src/commands/profile/handler";
import { runProfileCommand } from "../../src/commands/profile/handler";
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

/** Gzip magic followed by bytes that are not valid UTF-8 or JSON, so a text read would corrupt them. */
const GZIP_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x7b]);

const URL = "https://app.example.com/__profile";

interface RecordedCall {
    body: unknown;
    headers: Record<string, string>;
    method: string;
    url: string;
}

/** A stand-in for the admin fetch: records each call and answers with what `respond` returns. */
const fakeFetch = (respond: () => Response | Promise<Response>): { calls: RecordedCall[]; fetchImpl: ProfileCommandOptions["fetchImpl"] } => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async (input: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => {
        calls.push({
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
            headers: init?.headers ?? {},
            method: init?.method ?? "GET",
            url: input,
        });

        return respond();
    }) as unknown as ProfileCommandOptions["fetchImpl"];

    return { calls, fetchImpl };
};

describe("lunora profile", () => {
    let cwd: string;
    let savedToken: string | undefined;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-profile-"));
        // The admin bearer may come from the environment, which would hide the "no token" path.
        savedToken = process.env.LUNORA_ADMIN_TOKEN;
        delete process.env.LUNORA_ADMIN_TOKEN;
    });

    afterEach(() => {
        if (savedToken === undefined) {
            delete process.env.LUNORA_ADMIN_TOKEN;
        } else {
            process.env.LUNORA_ADMIN_TOKEN = savedToken;
        }

        rmSync(cwd, { force: true, recursive: true });
    });

    const base = (overrides: Partial<ProfileCommandOptions> = {}): ProfileCommandOptions => {
        return {
            cwd,
            logger: recordingLogger().logger,
            target: "node",
            token: "tok",
            url: URL,
            ...overrides,
        };
    };

    it("refuses the cloudflare target and points at `lunora cloudflare profile` (USAGE)", async () => {
        expect.assertions(3);

        const { lines, logger } = recordingLogger();
        const result = await runProfileCommand(base({ logger, target: "cloudflare" }));

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain("lunora cloudflare profile");
        expect(lines.join("\n")).toContain("lunora cloudflare profile");
    });

    it("refuses a project with no configured target, which resolves to cloudflare, before any request (USAGE)", async () => {
        expect.assertions(3);

        const { calls, fetchImpl } = fakeFetch(() => new Response(GZIP_BYTES));
        const { lines, logger } = recordingLogger();
        const result = await runProfileCommand(base({ fetchImpl, logger, target: undefined }));

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(lines.join("\n")).toContain("lunora cloudflare profile");
        expect(calls).toHaveLength(0);
    });

    it("refuses when no URL is given, because a Node app has no default endpoint (USAGE)", async () => {
        expect.assertions(2);

        const result = await runProfileCommand(base({ url: undefined }));

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain("--url");
    });

    it.each([
        ["an unknown type", { profileType: "trace" }],
        ["a duration under the floor", { durationMs: "999" }],
        ["a duration over the ceiling", { durationMs: "50001" }],
        ["a fractional duration", { durationMs: "1500.5" }],
    ])("refuses %s before any request (USAGE)", async (_label, overrides) => {
        expect.assertions(2);

        const { calls, fetchImpl } = fakeFetch(() => new Response(GZIP_BYTES));
        const result = await runProfileCommand(base({ ...overrides, fetchImpl }));

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
    });

    it("refuses a non-loopback http URL, which would send the bearer in cleartext (USAGE)", async () => {
        expect.assertions(2);

        const { calls, fetchImpl } = fakeFetch(() => new Response(GZIP_BYTES));
        const result = await runProfileCommand(base({ fetchImpl, url: "http://app.example.com/__profile" }));

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
    });

    it("refuses without any admin token (AUTH)", async () => {
        expect.assertions(2);

        const { calls, fetchImpl } = fakeFetch(() => new Response(GZIP_BYTES));
        const result = await runProfileCommand(base({ fetchImpl, token: undefined }));

        expect(result.code).toBe(EXIT_CODE.AUTH);
        expect(calls).toHaveLength(0);
    });

    it("pOSTs duration and type with the bearer, and writes the gzip to --out atomically", async () => {
        expect.assertions(5);

        const { calls, fetchImpl } = fakeFetch(() => new Response(GZIP_BYTES, { headers: { "content-type": "application/gzip" } }));
        const out = join(cwd, "nested", "cpu.pprof.gz");
        const result = await runProfileCommand(base({ durationMs: "2000", fetchImpl, out, profileType: "heap" }));

        expect(result.code).toBe(EXIT_CODE.SUCCESS);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            body: { duration_ms: 2000, profile_type: "heap" },
            headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
            method: "POST",
            url: URL,
        });
        expect(readFileSync(out)).toStrictEqual(Buffer.from(GZIP_BYTES));
        expect(result.data?.bytes).toBe(GZIP_BYTES.byteLength);
    });

    it("defaults to a 10 s cpu capture and names the file profile-<type>-<time>.pprof.gz", async () => {
        expect.assertions(3);

        const { calls, fetchImpl } = fakeFetch(() => new Response(GZIP_BYTES));
        const result = await runProfileCommand(base({ fetchImpl, now: new Date("2026-10-10T12:00:00.000Z") }));

        expect(calls[0]?.body).toStrictEqual({ duration_ms: 10_000, profile_type: "cpu" });
        expect(result.data?.file).toBe(join(cwd, "profile-cpu-2026-10-10T12-00-00-000Z.pprof.gz"));
        expect(existsSync(result.data?.file ?? "")).toBe(true);
    });

    it.each([
        [401, EXIT_CODE.AUTH],
        [403, EXIT_CODE.PERMISSION],
        [404, EXIT_CODE.NOT_FOUND],
        [405, EXIT_CODE.USAGE],
        [409, EXIT_CODE.CONFLICT],
        [500, EXIT_CODE.FAILURE],
    ])("maps an HTTP %i to its exit code %i and carries the app's message", async (status, code) => {
        expect.assertions(2);

        const { fetchImpl } = fakeFetch(() =>
            Response.json({ error: { code: "X", message: "the app said no" } }, { status, headers: { "content-type": "application/json" } }),
        );
        const result = await runProfileCommand(base({ fetchImpl }));

        expect(result.code).toBe(code);
        expect(result.error).toContain("the app said no");
    });

    it("refuses a 200 whose body is not a gzip profile, and writes nothing", async () => {
        expect.assertions(2);

        const out = join(cwd, "out.pprof.gz");
        const { fetchImpl } = fakeFetch(() => new Response('{"error":{"message":"not a profile"}}', { status: 200 }));
        const result = await runProfileCommand(base({ fetchImpl, out }));

        expect(result.code).toBe(EXIT_CODE.FAILURE);
        expect(existsSync(out)).toBe(false);
    });

    it("maps a refused connection to UNAVAILABLE", async () => {
        expect.assertions(2);

        const fetchImpl = (async () => {
            throw new Error("could not reach https://app.example.com/__profile (ECONNREFUSED)");
        }) as unknown as ProfileCommandOptions["fetchImpl"];
        const result = await runProfileCommand(base({ fetchImpl }));

        expect(result.code).toBe(EXIT_CODE.UNAVAILABLE);
        expect(result.error).toContain("ECONNREFUSED");
    });

    it("does not overwrite an existing profile when the write fails", async () => {
        expect.assertions(2);

        writeFileSync(join(cwd, "keep.txt"), "keep");
        const { fetchImpl } = fakeFetch(() => new Response(GZIP_BYTES));
        const result = await runProfileCommand(base({ fetchImpl, out: join(cwd, "keep.txt", "inner.pprof.gz") }));

        expect(result.code).toBe(EXIT_CODE.FAILURE);
        expect(readFileSync(join(cwd, "keep.txt"), "utf8")).toBe("keep");
    });
});
