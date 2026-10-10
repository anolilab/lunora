import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/** Gzip magic followed by bytes that are neither valid UTF-8 nor JSON. */
const GZIP_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x7b]);

const URL = "https://app.example.com/__profile";

interface RecordedCall {
    body: unknown;
    headers: Record<string, string>;
    method: string;
    url: string;
}

/** A stand-in for the admin fetch: records each call and answers with a gzip profile. */
const fakeFetch = (): { calls: RecordedCall[]; fetchImpl: ProfileCommandOptions["fetchImpl"] } => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (async (input: string, init?: { body?: string; headers?: Record<string, string>; method?: string }) => {
        calls.push({
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
            headers: init?.headers ?? {},
            method: init?.method ?? "GET",
            url: input,
        });

        return new Response(GZIP_BYTES);
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
        expect.assertions(4);

        const { calls, fetchImpl } = fakeFetch();
        const { lines, logger } = recordingLogger();
        const result = await runProfileCommand(base({ fetchImpl, logger, target: "cloudflare" }));

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(result.error).toContain("lunora cloudflare profile");
        expect(lines.join("\n")).toContain("lunora cloudflare profile");
        expect(calls).toHaveLength(0);
    });

    it("refuses a project with no configured target, which resolves to cloudflare, before any request (USAGE)", async () => {
        expect.assertions(3);

        const { calls, fetchImpl } = fakeFetch();
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

    it("refuses a non-loopback http URL, which would send the bearer in cleartext (USAGE)", async () => {
        expect.assertions(2);

        const { calls, fetchImpl } = fakeFetch();
        const result = await runProfileCommand(base({ fetchImpl, url: "http://app.example.com/__profile" }));

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
    });

    it("refuses without any admin token (AUTH)", async () => {
        expect.assertions(2);

        const { calls, fetchImpl } = fakeFetch();
        const result = await runProfileCommand(base({ fetchImpl, token: undefined }));

        expect(result.code).toBe(EXIT_CODE.AUTH);
        expect(calls).toHaveLength(0);
    });

    it("pOSTs the duration and type to the URL with the bearer, and writes the profile to --out", async () => {
        expect.assertions(5);

        const { calls, fetchImpl } = fakeFetch();
        const out = join(cwd, "nested", "cpu.pprof.gz");
        const result = await runProfileCommand(base({ durationMs: "2000", fetchImpl, out, profileType: "heap" }));

        expect(result.code).toBe(EXIT_CODE.SUCCESS);
        expect(calls[0]).toMatchObject({
            body: { duration_ms: 2000, profile_type: "heap" },
            headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
            method: "POST",
            url: URL,
        });
        expect(readFileSync(out)).toStrictEqual(Buffer.from(GZIP_BYTES));
        expect(result.data?.bytes).toBe(GZIP_BYTES.byteLength);
        expect(result.data?.url).toBe(URL);
    });

    it("names the default file profile-<type>-<time>.pprof.gz in the working directory", async () => {
        expect.assertions(1);

        const { fetchImpl } = fakeFetch();
        const result = await runProfileCommand(base({ fetchImpl, now: new Date("2026-10-10T12:00:00.000Z") }));

        expect(result.data?.file).toBe(join(cwd, "profile-cpu-2026-10-10T12-00-00-000Z.pprof.gz"));
    });
});
