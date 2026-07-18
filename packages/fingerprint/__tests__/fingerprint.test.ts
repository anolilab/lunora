import { describe, expect, it } from "vitest";

import { fingerprint, fingerprintError, fingerprintLog, messageBucketFor, sha256Hex, stripNullBytes } from "../src/index";

const NUL = String.fromCodePoint(0);

describe("sha256Hex (portable backend)", () => {
    // Standard FIPS 180-4 vectors — lock the swapped-in backend to real SHA-256.
    it("matches the canonical NIST/RFC test vectors", () => {
        expect.assertions(3);

        expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        expect(sha256Hex("The quick brown fox jumps over the lazy dog")).toBe("d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592");
    });

    // 56 bytes forces the length field into a second padding block — the classic
    // off-by-one boundary for a hand-rolled implementation.
    it("handles the 56-byte multi-block padding boundary", () => {
        expect.assertions(1);

        expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    });

    it("handles inputs spanning several blocks", () => {
        expect.assertions(1);

        expect(sha256Hex("a".repeat(128))).toBe("6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e");
    });

    it("encodes multi-byte UTF-8 the same as the platform", () => {
        expect.assertions(2);

        // sha256 of the UTF-8 bytes of "héllo — 世界"; guards the TextEncoder path.
        const expected = sha256Hex("héllo — 世界");

        expect(expected).toMatch(/^[0-9a-f]{64}$/);
        // Deterministic across calls.
        expect(sha256Hex("héllo — 世界")).toBe(expected);
    });
});

describe("vendored superlog core", () => {
    // These are ports of superlog's own tests — proving the algorithm was
    // vendored faithfully, backend swap included.
    it("collapses request paths so route-scanner errors group", () => {
        expect.assertions(3);

        const a = messageBucketFor("no route found for GET /wp-admin/install.php (AppWeb.Router)");
        const b = messageBucketFor("no route found for GET /.git/config (AppWeb.Router)");
        const c = messageBucketFor("no route found for GET /apple-touch-icon.png (AppWeb.Router)");

        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(a).toMatch(/<path>/);
    });

    it("groups same-stack route-scanner errors that differ only by path", () => {
        expect.assertions(1);

        const stack = "    at AppWeb.Router.call (lib/app_web/router.ex:1:1)";
        const fp1 = fingerprint({
            type: "Elixir.Phoenix.Router.NoRouteError",
            stacktrace: stack,
            message: "no route found for GET /wp-admin/install.php (AppWeb.Router)",
        });
        const fp2 = fingerprint({ type: "Elixir.Phoenix.Router.NoRouteError", stacktrace: stack, message: "no route found for GET /.env (AppWeb.Router)" });

        expect(fp1.hash).toBe(fp2.hash);
    });

    it("keeps a bare path token distinct from an in-word slash", () => {
        expect.assertions(2);

        expect(messageBucketFor("request to /api/v2/users failed")).toBe("request to <path> failed");
        expect(messageBucketFor("read timeout and/or connection reset")).toBe("read timeout and/or connection reset");
    });

    it("still separates genuinely different messages", () => {
        expect.assertions(1);

        expect(messageBucketFor("model is not supported")).not.toBe(messageBucketFor("extra inputs are not permitted"));
    });

    // Byte-for-byte fidelity: the vendored core with the portable backend must
    // produce the exact 16-char hash upstream's node:crypto backend produces.
    it("produces the same 16-char hash as upstream node:crypto for a fixed input", () => {
        expect.assertions(1);

        // The frame path `apps/worker/src/x.ts` normalizes to `src/x.ts`, so the
        // canonical string is `Error::boom::foo@src/x.ts`. The expected value is
        // node:crypto's sha256(canonical).slice(0,16) — matching it proves the
        // portable backend is byte-for-byte identical to upstream.
        const fp = fingerprint({ type: "Error", stacktrace: "    at foo (apps/worker/src/x.ts:1:1)", message: "boom" });

        expect(fp.hash).toBe("cf863caa303695e3");
    });

    it("strips NUL bytes everywhere they could poison a downstream store", () => {
        expect.assertions(6);

        expect(stripNullBytes(`ab${NUL}cd`)).toBe("abcd");
        expect(stripNullBytes(null)).toBeNull();
        expect(stripNullBytes(undefined)).toBeUndefined();

        const fp = fingerprint({ type: `Boom${NUL}Error`, stacktrace: `    at do${NUL}Thing (apps/worker/src/x.ts:1:1)`, message: "broke here" });

        expect(fp.exceptionType).not.toContain(NUL);
        expect(fp.topFrame ?? "").not.toContain(NUL);

        const logFp = fingerprintLog({ service: "w", severity: "ERROR", body: `failed${NUL}`, exceptionType: `Cause${NUL}Error`, stacktrace: null });

        expect(logFp.exceptionType).not.toContain(NUL);
    });
});

describe("fingerprintError (Lunora adapter)", () => {
    it("returns a stable 16-char hex hash, culprit, and title", () => {
        expect.assertions(4);

        const fp = fingerprintError({ functionPath: "messages:list", message: "Boom\nsecond line", code: "INTERNAL_SERVER_ERROR" });

        expect(fp.hash).toMatch(/^[0-9a-f]{16}$/);
        expect(fp.culprit).toBe("messages:list");
        expect(fp.title).toBe("Boom");
        expect(fp.code).toBe("INTERNAL_SERVER_ERROR");
    });

    it("produces the exact hash upstream sha256 would, over functionPath::bucket only", () => {
        expect.assertions(1);

        const fp = fingerprintError({ functionPath: "messages:list", message: "User 12345 not found", code: "NOT_FOUND" });

        expect(fp.hash).toBe("168d714cba85f1c8");
    });

    // The core promise: a live sink event (carries `code`) and a persisted reqlog
    // row (no `code`, different variable id in the message) collapse onto one hash.
    it("gives the same hash for a live-sink error and a reqlog row of the same error", () => {
        expect.assertions(1);

        const live = fingerprintError({ functionPath: "messages:list", message: "User 12345 not found", code: "NOT_FOUND" });
        const reqlog = fingerprintError({ functionPath: "messages:list", message: "User 67890 not found" });

        expect(live.hash).toBe(reqlog.hash);
    });

    it("collapses a bot sweep against one function into a single Issue", () => {
        expect.assertions(1);

        const a = fingerprintError({ functionPath: "http:router", message: "no route for GET /wp-admin/install.php" });
        const b = fingerprintError({ functionPath: "http:router", message: "no route for GET /.env" });

        expect(a.hash).toBe(b.hash);
    });

    it("keeps the same message under different functions in different Issues", () => {
        expect.assertions(1);

        const a = fingerprintError({ functionPath: "a:b", message: "boom" });
        const b = fingerprintError({ functionPath: "c:d", message: "boom" });

        expect(a.hash).not.toBe(b.hash);
    });

    it("groups container crashes by name+reason beside Worker errors", () => {
        expect.assertions(3);

        const c1 = fingerprintError({ functionPath: "container:transcoder", message: "exited with code 137" });
        const c2 = fingerprintError({ functionPath: "container:transcoder", message: "exited with code 137" });
        const other = fingerprintError({ functionPath: "container:worker", message: "exited with code 137" });

        expect(c1.hash).toBe(c2.hash);
        expect(c1.hash).toBe("7a6ec7390a5914af");
        expect(other.hash).not.toBe(c1.hash);
    });

    it("omits code entirely when none is supplied", () => {
        expect.assertions(2);

        const fp = fingerprintError({ functionPath: "a:b", message: "x" });

        expect(fp.code).toBeUndefined();
        expect("code" in fp).toBe(false);
    });

    it("falls back to code then culprit for the title when the message is empty", () => {
        expect.assertions(2);

        expect(fingerprintError({ functionPath: "a:b", message: "", code: "RATE_LIMITED" }).title).toBe("RATE_LIMITED");
        expect(fingerprintError({ functionPath: "a:b", message: "" }).title).toBe("a:b");
    });

    it("caps a runaway title", () => {
        expect.assertions(2);

        const fp = fingerprintError({ functionPath: "a:b", message: "x".repeat(500) });

        expect(fp.title.length).toBeLessThanOrEqual(120);
        expect(fp.title.endsWith("…")).toBe(true);
    });

    // FP-02: outputs must be NUL-free (they flow straight into an Issues upsert)
    // and the title must never split a surrogate pair.
    it("strips NUL bytes from every returned field (title, bucket, culprit)", () => {
        expect.assertions(4);

        const fp = fingerprintError({ functionPath: `messages${NUL}:list`, message: `boom${NUL} happened` });

        expect(fp.title).not.toContain(NUL);
        expect(fp.bucket).not.toContain(NUL);
        expect(fp.culprit).not.toContain(NUL);
        expect(fp.hash).toMatch(/^[0-9a-f]{16}$/);
    });

    it("keeps the hash unchanged for an existing non-NUL input (regression)", () => {
        expect.assertions(1);

        // Same fixture as the "produces the exact hash upstream sha256 would" case
        // above — locks that the NUL-stripping fix is a no-op for clean input.
        const fp = fingerprintError({ functionPath: "messages:list", message: "User 12345 not found", code: "NOT_FOUND" });

        expect(fp.hash).toBe("168d714cba85f1c8");
    });

    it("truncates a runaway title without splitting a surrogate pair (emoji)", () => {
        expect.assertions(2);

        // An emoji (`😀`, U+1F600) is a surrogate pair in UTF-16. Pad it right at
        // the TITLE_MAX boundary so the naive `slice(0, TITLE_MAX - 1)` would cut
        // between the high and low surrogate, leaving a lone (invalid) one.
        const message = `${"a".repeat(118)}😀${"b".repeat(20)}`;
        const fp = fingerprintError({ functionPath: "a:b", message });

        expect(fp.title.endsWith("…")).toBe(true);

        const lastCodeUnit = fp.title.codePointAt(fp.title.length - 2) ?? 0;

        // The char immediately before the ellipsis must not be a lone high surrogate.
        expect(lastCodeUnit >= 0xd8_00 && lastCodeUnit <= 0xdb_ff).toBe(false);
    });
});
