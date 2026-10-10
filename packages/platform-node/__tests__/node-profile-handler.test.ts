import { LunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import { createNodeProfileHandler } from "../src/node-profile-handler";
import type { NodeProfiler, NodeProfileRequest } from "../src/node-profiler";

const TOKEN = "s3cret-admin-token";

/** A profiler that never touches the inspector: it records what it was asked and answers with fixed bytes. */
const fakeProfiler = (respond: () => Promise<Uint8Array> = async () => new Uint8Array([0x1f, 0x8b, 0x08, 0x00])) => {
    const capture = vi.fn<(request: NodeProfileRequest) => Promise<Uint8Array>>(respond);
    const profiler: NodeProfiler = { capture };

    return { capture, profiler };
};

/** A POST with the right bearer. Passing `headers` replaces them entirely, so `{}` sends no bearer at all. */
const post = (body: unknown, headers?: Record<string, string>): Request =>
    new Request("https://app.example.com/__profile", {
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: headers ?? { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        method: "POST",
    });

describe("createNodeProfileHandler", () => {
    it("refuses an empty token at creation, so it cannot serve an open endpoint", () => {
        expect.assertions(1);

        expect(() => createNodeProfileHandler({ token: "" })).toThrow(LunoraError);
    });

    it("answers 200 with the gzip profile as application/gzip and passes the snake_case body through", async () => {
        expect.assertions(4);

        const bytes = new Uint8Array([0x1f, 0x8b, 9, 9]);
        const { capture, profiler } = fakeProfiler(async () => bytes);
        const handler = createNodeProfileHandler({ profiler, token: TOKEN });

        const response = await handler(post({ duration_ms: 2500, profile_type: "heap" }));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/gzip");
        expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(bytes);
        expect(capture).toHaveBeenCalledWith({ durationMs: 2500, profileType: "heap" });
    });

    it("answers 401 with a Bearer challenge when no bearer is sent", async () => {
        expect.assertions(3);

        const { capture, profiler } = fakeProfiler();
        const handler = createNodeProfileHandler({ profiler, token: TOKEN });

        const response = await handler(post({ duration_ms: 1000, profile_type: "cpu" }, {}));

        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
        expect(capture).not.toHaveBeenCalled();
    });

    it("treats a header that is not a bearer as missing", async () => {
        expect.assertions(1);

        const handler = createNodeProfileHandler({ profiler: fakeProfiler().profiler, token: TOKEN });

        const response = await handler(post({ duration_ms: 1000, profile_type: "cpu" }, { authorization: `Basic ${TOKEN}` }));

        expect(response.status).toBe(401);
    });

    it("answers 403 for a bearer that does not match, including one that is a prefix of the token", async () => {
        expect.assertions(2);

        const { capture, profiler } = fakeProfiler();
        const handler = createNodeProfileHandler({ profiler, token: TOKEN });

        const wrong = await handler(post({ duration_ms: 1000, profile_type: "cpu" }, { authorization: "Bearer s3cret" }));

        expect(wrong.status).toBe(403);
        expect(capture).not.toHaveBeenCalled();
    });

    it("answers 405 with Allow: POST for an authenticated GET, and does not run a capture", async () => {
        expect.assertions(3);

        const { capture, profiler } = fakeProfiler();
        const handler = createNodeProfileHandler({ profiler, token: TOKEN });

        const response = await handler(new Request("https://app.example.com/__profile", { headers: { authorization: `Bearer ${TOKEN}` } }));

        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
        expect(capture).not.toHaveBeenCalled();
    });

    it("answers 400 for a body that is not JSON or not a JSON object, without running a capture", async () => {
        expect.assertions(3);

        const { capture, profiler } = fakeProfiler();
        const handler = createNodeProfileHandler({ profiler, token: TOKEN });

        const notJson = await handler(post("{not json"));
        const notObject = await handler(post([1, 2]));

        expect(notJson.status).toBe(400);
        expect(notObject.status).toBe(400);
        expect(capture).not.toHaveBeenCalled();
    });

    it("answers 400 for a duration or type the profiler refuses, using the real validation", async () => {
        expect.assertions(4);

        const handler = createNodeProfileHandler({ token: TOKEN });

        const tooShort = await handler(post({ duration_ms: 999, profile_type: "cpu" }));
        const badType = await handler(post({ duration_ms: 1000, profile_type: "trace" }));
        // A string duration is not a number, so the handler does not coerce it into one.
        const stringDuration = await handler(post({ duration_ms: "5000", profile_type: "cpu" }));
        const missingType = await handler(post({ duration_ms: 1000 }));

        expect(tooShort.status).toBe(400);
        expect(badType.status).toBe(400);
        expect(stringDuration.status).toBe(400);
        expect(missingType.status).toBe(400);
    });

    it("answers 409 while another capture is running", async () => {
        expect.assertions(3);

        const { profiler } = fakeProfiler(async () => {
            throw new LunoraError("CONFLICT", "a profile capture is already running in this process; wait for it to finish");
        });
        const handler = createNodeProfileHandler({ profiler, token: TOKEN });

        const response = await handler(post({ duration_ms: 1000, profile_type: "cpu" }));
        const body = (await response.json()) as { error: { code: string; message: string } };

        expect(response.status).toBe(409);
        expect(body.error.code).toBe("CONFLICT");
        expect(body.error.message).toBe("a profile capture is already running in this process; wait for it to finish");
    });

    it("answers 500 with a redacted message for an unexpected failure, and does not leak it", async () => {
        expect.assertions(2);

        const { profiler } = fakeProfiler(async () => {
            throw new Error("inspector exploded at /home/app/secret");
        });
        const handler = createNodeProfileHandler({ profiler, token: TOKEN });

        const response = await handler(post({ duration_ms: 1000, profile_type: "cpu" }));
        const text = await response.text();

        expect(response.status).toBe(500);
        expect(text).not.toContain("secret");
    });
});
