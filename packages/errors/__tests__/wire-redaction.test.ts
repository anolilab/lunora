import { describe, expect, it } from "vitest";

import { ERROR_CATALOG, isInternalCode, isLunoraError, LunoraError, toErrorBody } from "../src";

const codes = Object.keys(ERROR_CATALOG) as (keyof typeof ERROR_CATALOG)[];
const internalCodes = codes.filter((code) => isInternalCode(code));
const publicCodes = codes.filter((code) => !isInternalCode(code));

// A message that must never be visible on the wire when redaction applies —
// the kind of detail (SQL fragment, file path, internal id) an internal
// failure realistically carries. Not a credential — just a leak marker.
const INTERNAL_DETAIL = "SELECT * FROM users WHERE id = 7 -- INTERNAL_LEAK_MARKER at /srv/app/lunora/handler.ts:42";

// `toErrorBody` is the single wire-redaction seam: every transport edge (HTTP
// mapper, DO RPC mapper, WS/SSE frames) delegates here. These tests sweep the
// entire catalog so adding a code automatically extends the guarantee.
describe("toErrorBody redaction sweep", () => {
    it.each(internalCodes)("%s never leaks message, hint, data, or docsUrl", (code) => {
        const error = new LunoraError(code, INTERNAL_DETAIL, {
            data: { secretPath: "/etc/shadow" },
            docsUrl: "https://internal.example/runbook",
            hint: "internal runbook hint",
        });
        const { body, redacted, status } = toErrorBody(error, { encodeData: (d) => d });

        expect(redacted).toBe(true);
        expect(status).toBe(ERROR_CATALOG[code].status);
        expect(body.code).toBe(code);
        expect(body.message).toBe("Internal error");
        expect(body.message).not.toContain("INTERNAL_LEAK_MARKER");
        // The redacted branch builds a minimal body — nothing else may ride along.
        expect(body.hint).toBeUndefined();
        expect(body.data).toBeUndefined();
        expect(body.docsUrl).toBeUndefined();
        expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["code", "message"]);
    });

    it.each(publicCodes)("%s echoes its message (the author's vouch that it is client-safe)", (code) => {
        const { body, redacted, status } = toErrorBody(new LunoraError(code, "client-safe detail"));

        expect(redacted).toBe(false);
        expect(status).toBe(ERROR_CATALOG[code].status);
        expect(body.code).toBe(code);
        expect(body.message).toBe("client-safe detail");
    });

    it("redacts an internal code carried by a wire-decoded twin, not just a real LunoraError", () => {
        // A DO→worker hop decodes to a plain Error with copied own props; the
        // redaction must key off the structural shape, not the class.
        const twin = Object.assign(new Error(INTERNAL_DETAIL), { code: "INTERNAL", status: 500, type: "VisimaError" });

        // Sanity: with a wrong brand it is NOT recognized, and still redacted via the fallback path.
        expect(isLunoraError(twin)).toBe(false);

        const branded = Object.assign(new Error(INTERNAL_DETAIL), { code: "INTERNAL", status: 500, type: "VisulimaError" });
        const { body, redacted } = toErrorBody(branded);

        expect(isLunoraError(branded)).toBe(true);
        expect(redacted).toBe(true);
        expect(body.message).not.toContain("INTERNAL_LEAK_MARKER");
    });

    it("echoes a wire-decoded twin's public code with its data and docsUrl", () => {
        const twin = Object.assign(new Error("stale write"), {
            code: "CONFLICT",
            data: { retryAfterMs: 25 },
            docsUrl: "https://lunora.sh/docs/errors#conflict",
            status: 409,
            type: "VisulimaError",
        });
        const { body, redacted, status } = toErrorBody(twin, { encodeData: (d) => d });

        expect(redacted).toBe(false);
        expect(status).toBe(409);
        expect(body.message).toBe("stale write");
        expect(body.data).toStrictEqual({ retryAfterMs: 25 });
        expect(body.docsUrl).toBe("https://lunora.sh/docs/errors#conflict");
    });
});

describe("toErrorBody fallback path", () => {
    it("redacts every non-LunoraError throw to the INTERNAL default", () => {
        for (const thrown of [new Error(INTERNAL_DETAIL), INTERNAL_DETAIL, 42, null, undefined, { message: INTERNAL_DETAIL }, new TypeError(INTERNAL_DETAIL)]) {
            const { body, redacted, status } = toErrorBody(thrown);

            expect(redacted).toBe(true);
            expect(status).toBe(500);
            expect(body.code).toBe("INTERNAL");
            expect(body.message).toBe("Internal error");
        }
    });

    it("honours fallbackCode and redactedMessage overrides together", () => {
        const { body } = toErrorBody("boom", { fallbackCode: "RPC_FAILED", redactedMessage: "something went wrong" });

        expect(body.code).toBe("RPC_FAILED");
        expect(body.message).toBe("something went wrong");
    });

    it("applies redactedMessage to the internal-coded branch too", () => {
        const { body } = toErrorBody(new LunoraError("ENV_INVALID", "MISSING: STRIPE_INTERNAL_DETAIL_KEY"), { redactedMessage: "config error" });

        expect(body.message).toBe("config error");
        expect(body.message).not.toContain("STRIPE_INTERNAL_DETAIL_KEY");
    });

    it("a foreign error with code+status but no brand is never echoed", () => {
        // The `type: "VisulimaError"` brand is the vouch. A pg/driver error with
        // its own `code` must not ride the echo path.
        const driverError = Object.assign(new Error(INTERNAL_DETAIL), { code: "23505", status: 409 });
        const { body, redacted, status } = toErrorBody(driverError);

        expect(redacted).toBe(true);
        expect(status).toBe(500);
        expect(body.message).not.toContain("INTERNAL_LEAK_MARKER");
    });
});

describe("toErrorBody data encoding", () => {
    it("drops data without an encoder, even on the echo path", () => {
        const error = new LunoraError("VALIDATION_ERROR", "bad field", { data: { bigCount: 1n } });

        expect(toErrorBody(error).body.data).toBeUndefined();
    });

    it("runs the injected encoder over the data verbatim", () => {
        const error = new LunoraError("VALIDATION_ERROR", "bad field", { data: { bigCount: 1n } });
        const { body } = toErrorBody(error, {
            encodeData: (d) => {
                return { wire: String((d as { bigCount: bigint }).bigCount) };
            },
        });

        expect(body.data).toStrictEqual({ wire: "1" });
    });

    it("does not call the encoder when data is undefined", () => {
        let called = 0;
        const { body } = toErrorBody(new LunoraError("NOT_FOUND", "gone"), {
            encodeData: (d) => {
                called += 1;

                return d;
            },
        });

        expect(called).toBe(0);
        expect(body.data).toBeUndefined();
    });
});

describe("lunora error wire shape", () => {
    it("serializes every transport field as own-enumerable JSON", () => {
        const error = new LunoraError("CONFLICT", "stale", { data: { v: 2 }, docsUrl: "https://lunora.sh/docs" });
        // Own-enumerable props are exactly what the wire codec copies.
        const parsed = Object.fromEntries(Object.entries(error)) as Record<string, unknown>;

        expect(parsed.type).toBe("VisulimaError");
        expect(parsed.code).toBe("CONFLICT");
        expect(parsed.status).toBe(409);
        expect(parsed.data).toStrictEqual({ v: 2 });
        expect(parsed.docsUrl).toBe("https://lunora.sh/docs");
        expect(parsed.title).toBe(ERROR_CATALOG.CONFLICT.title);
    });

    it("a spread-and-rebuilt error is still recognized and redacts identically", () => {
        // Round-trip the own props the wire codec copies onto a fresh Error —
        // exactly what happens across the DO↔worker RPC boundary.
        const original = new LunoraError("RUN_DEPTH_EXCEEDED", INTERNAL_DETAIL);
        const rebuilt = Object.assign(new Error(original.message), Object.fromEntries(Object.entries(original)));

        expect(isLunoraError(rebuilt)).toBe(true);

        const [a, b] = [toErrorBody(original), toErrorBody(rebuilt)];

        expect(a.body).toStrictEqual(b.body);
        expect(a.status).toBe(b.status);
        expect(a.redacted).toBe(true);
    });
});
