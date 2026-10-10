import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";
import type { CaptureOptions, CaptureRequestInit } from "../../src/util/pprof-capture";
import { captureProfile, validateProfileRequest, writeProfile } from "../../src/util/pprof-capture";

const recordingLogger = (): Logger => {
    return { error: () => undefined, info: () => undefined, success: () => undefined, warn: () => undefined };
};

/** Gzip magic followed by bytes that are neither valid UTF-8 nor JSON, so a text read would corrupt them. */
const GZIP_BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x7b]);

/** An error shaped like the one `AbortSignal.timeout` raises when its deadline passes. */
const timeoutError = (): Error => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

const captureOptions = (fetch: CaptureOptions["fetch"]): CaptureOptions => {
    return {
        body: { duration_ms: 1000, profile_type: "cpu" },
        describeBody: (text) => text.trim(),
        durationMs: 1000,
        fetch,
        headers: { Authorization: "Bearer tok" },
        hintForStatus: () => "",
        logger: recordingLogger(),
        url: "https://app.example.com/__profile",
    };
};

describe("validateProfileRequest", () => {
    it("defaults to a 10 s cpu capture", () => {
        expect.assertions(1);

        expect(validateProfileRequest(undefined, undefined)).toStrictEqual({ durationMs: 10_000, profileType: "cpu" });
    });

    it.each([
        ["an unknown type", "trace", undefined],
        ["a duration under the floor", undefined, "999"],
        ["a duration over the ceiling", undefined, "50001"],
        ["a fractional duration", undefined, "1500.5"],
        ["a non-numeric duration", undefined, "soon"],
    ])("refuses %s with a usage message", (_label, profileType, durationMs) => {
        expect.assertions(1);

        expect(validateProfileRequest(profileType, durationMs)).toHaveProperty("error");
    });

    it("accepts both bounds of the window", () => {
        expect.assertions(2);

        expect(validateProfileRequest("heap", "1000")).toStrictEqual({ durationMs: 1000, profileType: "heap" });
        expect(validateProfileRequest("heap", "50000")).toStrictEqual({ durationMs: 50_000, profileType: "heap" });
    });
});

describe("captureProfile", () => {
    it("pOSTs the body with the headers and returns the gzip bytes", async () => {
        expect.assertions(4);

        const calls: { init: CaptureRequestInit; input: string }[] = [];
        const outcome = await captureProfile(
            captureOptions(async (input, init) => {
                calls.push({ init, input });

                return new Response(GZIP_BYTES);
            }),
        );

        expect(outcome).toStrictEqual({ bytes: GZIP_BYTES });
        expect(calls[0]?.input).toBe("https://app.example.com/__profile");
        expect(calls[0]?.init).toMatchObject({
            body: JSON.stringify({ duration_ms: 1000, profile_type: "cpu" }),
            headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
            method: "POST",
        });
        expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    });

    it("refuses a 200 whose body is not a gzip profile", async () => {
        expect.assertions(2);

        const outcome = await captureProfile(captureOptions(async () => new Response('{"error":{"message":"not a profile"}}', { status: 200 })));

        expect(outcome).toMatchObject({ code: EXIT_CODE.FAILURE });
        expect(outcome).toHaveProperty("error", expect.stringContaining("not a profile"));
    });

    it.each([
        [401, EXIT_CODE.AUTH],
        [403, EXIT_CODE.PERMISSION],
        [404, EXIT_CODE.NOT_FOUND],
        [405, EXIT_CODE.USAGE],
        [409, EXIT_CODE.CONFLICT],
        [500, EXIT_CODE.FAILURE],
    ])("maps an HTTP %i to exit code %i and includes the endpoint's message", async (status, code) => {
        expect.assertions(2);

        const outcome = await captureProfile(captureOptions(async () => new Response("the endpoint said no", { status })));

        expect(outcome).toMatchObject({ code });
        expect(outcome).toHaveProperty("error", expect.stringContaining("the endpoint said no"));
    });

    it("maps a refused connection to UNAVAILABLE", async () => {
        expect.assertions(1);

        const outcome = await captureProfile(
            captureOptions(async () => {
                throw new Error("could not reach https://app.example.com/__profile (ECONNREFUSED)");
            }),
        );

        expect(outcome).toMatchObject({ code: EXIT_CODE.UNAVAILABLE });
    });

    it("maps a timeout while the body is read to UNAVAILABLE, not a thrown error", async () => {
        expect.assertions(1);

        const readTimesOut = {
            arrayBuffer: async () => {
                throw timeoutError();
            },
            ok: true,
            status: 200,
        } as unknown as Response;

        const outcome = await captureProfile(captureOptions(async () => readTimesOut));

        expect(outcome).toMatchObject({ code: EXIT_CODE.UNAVAILABLE });
    });

    it("maps a timeout while an error body is read to UNAVAILABLE, not a thrown error", async () => {
        expect.assertions(1);

        const errorBodyTimesOut = {
            ok: false,
            status: 409,
            text: async () => {
                throw timeoutError();
            },
        } as unknown as Response;

        const outcome = await captureProfile(captureOptions(async () => errorBodyTimesOut));

        expect(outcome).toMatchObject({ code: EXIT_CODE.UNAVAILABLE });
    });
});

describe("writeProfile", () => {
    let cwd: string;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "lunora-pprof-capture-"));
    });

    afterEach(() => {
        rmSync(cwd, { force: true, recursive: true });
    });

    it("writes to --out, creating its parent directories", () => {
        expect.assertions(2);

        const result = writeProfile(cwd, "nested/dir/cpu.pprof.gz", "unused.pprof.gz", GZIP_BYTES);

        expect(result).toStrictEqual({ file: join(cwd, "nested/dir/cpu.pprof.gz") });
        expect(readFileSync(join(cwd, "nested/dir/cpu.pprof.gz"))).toStrictEqual(Buffer.from(GZIP_BYTES));
    });

    it("uses the default name in the working directory when no --out is given", () => {
        expect.assertions(2);

        const result = writeProfile(cwd, undefined, "profile-cpu-now.pprof.gz", GZIP_BYTES);

        expect(result).toStrictEqual({ file: join(cwd, "profile-cpu-now.pprof.gz") });
        expect(existsSync(join(cwd, "profile-cpu-now.pprof.gz"))).toBe(true);
    });

    it("reports a write it cannot make and leaves the existing file untouched", () => {
        expect.assertions(2);

        // A regular file where the directory should be makes the directory creation fail.
        writeFileSync(join(cwd, "keep.txt"), "keep");

        const result = writeProfile(cwd, "keep.txt/inner.pprof.gz", "unused.pprof.gz", GZIP_BYTES);

        expect(result).toHaveProperty("error");
        expect(readFileSync(join(cwd, "keep.txt"), "utf8")).toBe("keep");
    });
});
