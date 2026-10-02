import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BoxMessage, CloudMessage, DecodeResult, HostdFrame, HostdMessage, ProtocolNegotiation } from "../src/protocol";
import {
    challengeSigningPayload,
    decodeBoxMessage,
    decodeCloudMessage,
    encodeMessage,
    HOSTD_AUTH_DOMAIN,
    HOSTD_PROTOCOL_LIMITS,
    HOSTD_PROTOCOL_VERSION,
    HOSTD_REQUEST_DOMAIN,
    isAlias,
    isHostname,
    negotiateProtocolVersion,
    peekProtocolVersion,
    requestSigningPayload,
} from "../src/protocol";

interface InvalidCase {
    code: string;
    frame: unknown;
    name: string;
    path?: string;
}

interface Fixtures {
    box: Record<string, BoxMessage>;
    cloud: Record<string, CloudMessage>;
    invalid: { box: InvalidCase[]; cloud: InvalidCase[] };
    protocolVersion: number;
    signing: {
        challenge: { boxId: string; nonce: string; payload: string };
        request: { boxId: string; method: string; nonce: string; path: string; payload: string; timestamp: number };
        "request-without-timestamp": { boxId: string; method: string; nonce: string; path: string; payload: string };
    };
}

const fixtures = JSON.parse(readFileSync(fileURLToPath(new URL("../../../protocol/hostd/fixtures/messages.json", import.meta.url)), "utf8")) as Fixtures;

const NONCE = fixtures.signing.challenge.nonce;
const BOX_ID = fixtures.signing.challenge.boxId;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const toFrame = (frame: unknown): string => (typeof frame === "string" ? frame : JSON.stringify(frame));

/** The shape of a rejection, for `toMatchObject`. */
const rejected = (code: string, path?: string): { error: { code: string; path?: string }; ok: false } => {
    return { error: path === undefined ? { code } : { code, path }, ok: false };
};

/**
 * Every copy of `message` with one unknown field added to one of its objects
 * (the top level, nested objects, array entries), paired with that field's
 * path. `vars` is skipped: it is a free-form map, where any env-shaped name is
 * a valid key.
 */
const replaceAt = (array: unknown[], index: number, value: unknown): unknown[] => array.map((other, otherIndex) => (otherIndex === index ? value : other));

const withUnknownField = (message: unknown): { frame: unknown; path: string }[] => {
    const variants: { frame: unknown; path: string }[] = [];
    const visit = (node: unknown, path: string, replace: (next: unknown) => unknown): void => {
        if (Array.isArray(node)) {
            node.forEach((entry, index) => {
                visit(entry, `${path}[${String(index)}]`, (next) => replace(replaceAt(node, index, next)));
            });

            return;
        }

        if (typeof node !== "object" || node === null) {
            return;
        }

        const record = node as Record<string, unknown>;

        variants.push({ frame: replace({ ...record, unknownField: true }), path: `${path}.unknownField` });

        for (const [key, value] of Object.entries(record)) {
            if (key !== "vars") {
                visit(value, `${path}.${key}`, (next) => replace({ ...record, [key]: next }));
            }
        }
    };

    visit(message, "$", (next) => next);

    return variants;
};

const decodeAny = (frame: HostdFrame): DecodeResult<HostdMessage> => {
    const box = decodeBoxMessage(frame);

    return box.ok ? box : decodeCloudMessage(frame);
};

describe("golden fixtures", () => {
    it("pin the current protocol version", () => {
        expect(fixtures.protocolVersion).toBe(HOSTD_PROTOCOL_VERSION);
    });

    it.each(Object.entries(fixtures.box))("decodes and round-trips box frame %s", (_name, frame) => {
        const decoded = decodeBoxMessage(JSON.stringify(frame));

        expect(decoded).toStrictEqual({ message: frame, ok: true });

        const reencoded = encodeMessage(frame);

        expect(JSON.parse(reencoded)).toStrictEqual(frame);
        expect(decodeBoxMessage(reencoded)).toStrictEqual(decoded);
    });

    it.each(Object.entries(fixtures.cloud))("decodes and round-trips cloud frame %s", (_name, frame) => {
        const decoded = decodeCloudMessage(JSON.stringify(frame));

        expect(decoded).toStrictEqual({ message: frame, ok: true });

        const reencoded = encodeMessage(frame);

        expect(JSON.parse(reencoded)).toStrictEqual(frame);
        expect(decodeCloudMessage(reencoded)).toStrictEqual(decoded);
    });

    it.each(fixtures.invalid.box.map((testCase) => [testCase.name, testCase] as const))("rejects box frame: %s", (_name, testCase) => {
        expect(decodeBoxMessage(toFrame(testCase.frame))).toMatchObject(rejected(testCase.code, testCase.path));
    });

    it.each(fixtures.invalid.cloud.map((testCase) => [testCase.name, testCase] as const))("rejects cloud frame: %s", (_name, testCase) => {
        expect(decodeCloudMessage(toFrame(testCase.frame))).toMatchObject(rejected(testCase.code, testCase.path));
    });

    it("rejects an unknown field at every level of every valid frame", () => {
        expect(withUnknownField(fixtures.box.hello).map((variant) => variant.path)).toStrictEqual([
            "$.unknownField",
            "$.versions.unknownField",
            "$.fleets[0].unknownField",
            "$.fleets[1].unknownField",
            "$.resources.unknownField",
        ]);

        for (const message of Object.values(fixtures.box)) {
            for (const { frame, path } of withUnknownField(message)) {
                expect(decodeBoxMessage(JSON.stringify(frame)), path).toMatchObject(rejected("INVALID_MESSAGE", path));
            }
        }

        for (const message of Object.values(fixtures.cloud)) {
            for (const { frame, path } of withUnknownField(message)) {
                expect(decodeCloudMessage(JSON.stringify(frame)), path).toMatchObject(rejected("INVALID_MESSAGE", path));
            }
        }
    });

    it("rejects every valid frame with any one required field removed", () => {
        for (const [decode, messages] of [
            [decodeBoxMessage, fixtures.box],
            [decodeCloudMessage, fixtures.cloud],
        ] as const) {
            for (const [name, message] of Object.entries(messages)) {
                for (const key of Object.keys(message).filter((field) => !["error", "type", "url"].includes(field))) {
                    const rest = Object.fromEntries(Object.entries(message).filter(([field]) => field !== key));

                    expect(decode(JSON.stringify(rest)).ok, `${name} without ${key}`).toBe(false);
                }
            }
        }
    });

    it("keeps every frame type and job kind covered by a valid fixture", () => {
        expect(new Set(Object.values(fixtures.box).map((message) => message.type))).toStrictEqual(
            new Set(["auth", "hello", "pong", "progress", "report", "result"]),
        );
        expect(new Set(Object.values(fixtures.cloud).map((message) => message.type))).toStrictEqual(new Set(["challenge", "error", "job", "ping", "routes"]));
        expect(
            new Set(
                Object.values(fixtures.cloud)
                    .filter((message) => message.type === "job")
                    .map((message) => message.job.kind),
            ),
        ).toStrictEqual(new Set(["deploy", "destroy", "diagnose", "reload", "upgrade"]));
    });
});

describe("decoding", () => {
    it("accepts binary frames holding UTF-8 JSON", () => {
        const bytes = new TextEncoder().encode(JSON.stringify(fixtures.box.pong));

        expect(decodeBoxMessage(bytes)).toStrictEqual({ message: { type: "pong" }, ok: true });
        expect(decodeBoxMessage(bytes.buffer)).toStrictEqual({ message: { type: "pong" }, ok: true });
    });

    it("rejects binary frames that are not UTF-8", () => {
        expect(decodeBoxMessage(new Uint8Array([0x7b, 0xff, 0x7d]))).toMatchObject(rejected("INVALID_JSON"));
    });

    it("never throws, whatever the input", () => {
        const inputs: HostdFrame[] = ["", "null", "42", '"hello"', "[1,2]", '{"type":null}', '{"type":"job","jobId":"j","job":null}', new Uint8Array(0)];

        for (const input of inputs) {
            expect(() => decodeBoxMessage(input)).not.toThrow();
            expect(() => decodeCloudMessage(input)).not.toThrow();
            expect(decodeBoxMessage(input).ok).toBe(false);
            expect(decodeCloudMessage(input).ok).toBe(false);
        }
    });

    it("treats the two directions as disjoint", () => {
        for (const frame of Object.values(fixtures.box)) {
            expect(decodeCloudMessage(JSON.stringify(frame))).toMatchObject(rejected("UNKNOWN_TYPE", "$.type"));
        }

        for (const frame of Object.values(fixtures.cloud)) {
            expect(decodeBoxMessage(JSON.stringify(frame))).toMatchObject(rejected("UNKNOWN_TYPE", "$.type"));
        }
    });
});

describe("size caps", () => {
    it("rejects a frame over the frame cap, as text and as bytes", () => {
        const line = "x".repeat(HOSTD_PROTOCOL_LIMITS.maxFrameBytes);
        const frame = JSON.stringify({ jobId: "job_1", line, type: "progress" });

        expect(decodeBoxMessage(frame)).toMatchObject(rejected("FRAME_TOO_LARGE"));
        expect(decodeBoxMessage(new TextEncoder().encode(frame))).toMatchObject(rejected("FRAME_TOO_LARGE"));
    });

    it("counts the frame cap in UTF-8 bytes, not characters", () => {
        // 3 bytes per character: under the cap in characters, over it in bytes.
        const vars = { BIG: "€".repeat(Math.ceil(HOSTD_PROTOCOL_LIMITS.maxFrameBytes / 3)) };
        const frame = JSON.stringify({
            job: { alias: "a", crons: [], deploymentId: "d", kind: "deploy", releaseUrl: "https://x.example/r", vars },
            jobId: "j",
            type: "job",
        });

        expect(frame.length).toBeLessThan(HOSTD_PROTOCOL_LIMITS.maxFrameBytes);
        expect(decodeCloudMessage(frame)).toMatchObject(rejected("FRAME_TOO_LARGE"));
    });

    it("caps progress.line at 8 KiB of UTF-8", () => {
        const atCap = { jobId: "job_1", line: "x".repeat(HOSTD_PROTOCOL_LIMITS.maxLineBytes), type: "progress" };
        const overCap = { ...atCap, line: `${"x".repeat(HOSTD_PROTOCOL_LIMITS.maxLineBytes - 1)}é` };

        expect(decodeBoxMessage(JSON.stringify(atCap)).ok).toBe(true);
        expect(decodeBoxMessage(JSON.stringify(overCap))).toMatchObject(rejected("INVALID_MESSAGE", "$.line"));
    });

    it("caps report.perAlias at 500 entries", () => {
        const entries = (count: number): unknown[] =>
            Array.from({ length: count }, (_, index) => {
                return { alias: `app-${String(index)}`, errors: 0, requests: 1 };
            });
        const report = (count: number): string => JSON.stringify({ perAlias: entries(count), type: "report", windowEnd: 1, windowStart: 0 });

        expect(decodeBoxMessage(report(HOSTD_PROTOCOL_LIMITS.maxReportAliases)).ok).toBe(true);
        expect(decodeBoxMessage(report(HOSTD_PROTOCOL_LIMITS.maxReportAliases + 1))).toMatchObject(rejected("INVALID_MESSAGE", "$.perAlias"));
    });

    it("caps routes.table at 10 000 entries", () => {
        const table = (count: number): { alias: string; hostname: string }[] =>
            Array.from({ length: count }, (_, index) => {
                return { alias: "a", hostname: `h${index.toString(36)}` };
            });

        // The array cap is checked before the frame is encoded, so encodeMessage
        // reaches it; on the decode side the frame cap always binds first, since
        // even 10 000 minimal entries exceed 256 KiB (see README section 4).
        expect(() => encodeMessage({ table: table(HOSTD_PROTOCOL_LIMITS.maxRoutes + 1), type: "routes" })).toThrow(
            /\$\.table must have at most 10000 entries/u,
        );
        expect(() => encodeMessage({ table: table(HOSTD_PROTOCOL_LIMITS.maxRoutes), type: "routes" })).toThrow(RangeError);
        expect(decodeCloudMessage(JSON.stringify({ table: table(HOSTD_PROTOCOL_LIMITS.maxRoutes), type: "routes" }))).toMatchObject(
            rejected("FRAME_TOO_LARGE"),
        );
    });

    it("fits a realistic routes table of a few thousand default hostnames in one frame", () => {
        const table = Array.from({ length: 3000 }, (_, index) => {
            return {
                alias: `app-${String(index)}`,
                hostname: `app-${String(index)}.box-7f3a.boxes.lunora.app`,
            };
        });

        expect(decodeCloudMessage(encodeMessage({ table, type: "routes" })).ok).toBe(true);
    });

    it("caps hello.fleets", () => {
        const { hello } = fixtures.box;
        const fleets = Array.from({ length: HOSTD_PROTOCOL_LIMITS.maxFleets + 1 }, (_, index) => {
            return { alias: `app-${String(index)}`, state: "running" };
        });

        expect(decodeBoxMessage(JSON.stringify({ ...hello, fleets }))).toMatchObject(rejected("INVALID_MESSAGE", "$.fleets"));
    });
});

describe("encodeMessage", () => {
    it("drops optional fields set to undefined", () => {
        expect(JSON.parse(encodeMessage({ jobId: "job_1", ok: true, type: "result", url: undefined }))).toStrictEqual({
            jobId: "job_1",
            ok: true,
            type: "result",
        });
    });

    it("throws a TypeError for a message its peer would reject", () => {
        expect(() => encodeMessage({ alias: "a", type: "pong" } as unknown as HostdMessage)).toThrow(TypeError);
        expect(() => encodeMessage({ type: "nope" } as unknown as HostdMessage)).toThrow(TypeError);
        expect(() => encodeMessage({ table: [{ alias: "Bad", hostname: "a.example.com" }], type: "routes" })).toThrow(/\$\.table\[0\]\.alias/u);
    });

    it("throws a RangeError for a frame over the cap", () => {
        const vars = { BIG: "x".repeat(HOSTD_PROTOCOL_LIMITS.maxFrameBytes) };

        expect(() =>
            encodeMessage({
                job: { alias: "a", crons: [], deploymentId: "d", kind: "deploy", releaseUrl: "https://x.example/r", vars },
                jobId: "j",
                type: "job",
            }),
        ).toThrow(RangeError);
    });

    it("produces frames every decoder accepts", () => {
        for (const frame of [...Object.values(fixtures.box), ...Object.values(fixtures.cloud)]) {
            expect(decodeAny(encodeMessage(frame)).ok).toBe(true);
        }
    });
});

describe("aliases and hostnames", () => {
    it.each(["a", "my-app", "app-1-2", "0", "a".repeat(63)])("accepts alias %s", (alias) => {
        expect(isAlias(alias)).toBe(true);
    });

    it.each(["", "My-App", "my--app", "-app", "app-", "my_app", "my.app", "a".repeat(64)])("rejects alias %s", (alias) => {
        expect(isAlias(alias)).toBe(false);
    });

    it.each(["localhost", "a.example.com", "my-app.box-7f3a.boxes.lunora.app", "xn--bcher-kva.example", "1.example.com", `${"a".repeat(63)}.com`])(
        "accepts hostname %s",
        (hostname) => {
            expect(isHostname(hostname)).toBe(true);
        },
    );

    it.each([
        "",
        "A.example.com",
        "a..example.com",
        "a.example.com.",
        "a_b.example.com",
        "-a.example.com",
        "a-.example.com",
        "example.123",
        "*.example.com",
        `${"a".repeat(64)}.com`,
        `${"a.".repeat(127)}com`,
    ])("rejects hostname %s", (hostname) => {
        expect(isHostname(hostname)).toBe(false);
    });
});

describe("version negotiation", () => {
    it("accepts the current version", () => {
        expect(negotiateProtocolVersion(HOSTD_PROTOCOL_VERSION)).toStrictEqual({ ok: true, version: HOSTD_PROTOCOL_VERSION });
    });

    it("accepts any version the control plane lists", () => {
        expect(negotiateProtocolVersion(2, [1, 2, 3])).toStrictEqual({ ok: true, version: 2 });
    });

    it("tells the operator to upgrade hostd when the box is behind", () => {
        expect(negotiateProtocolVersion(1, [2, 3])).toStrictEqual({
            code: "PROTOCOL_UNSUPPORTED",
            message: expect.stringMatching(/Upgrade lunora-hostd on this box/u),
            ok: false,
        });
    });

    it("says the control plane is behind when the box is ahead", () => {
        expect(negotiateProtocolVersion(HOSTD_PROTOCOL_VERSION + 1)).toStrictEqual({
            code: "PROTOCOL_UNSUPPORTED",
            message: expect.stringMatching(/newer than Lunora Cloud supports/u),
            ok: false,
        });
    });

    it("reads the announced version from a hello the strict decoder would reject", () => {
        const futureHello = JSON.stringify({ ...fixtures.box.hello, protocol: 2, region: "eu-central" });

        expect(decodeBoxMessage(futureHello)).toMatchObject(rejected("INVALID_MESSAGE", "$.region"));
        expect(peekProtocolVersion(futureHello)).toBe(2);
        expect(negotiateProtocolVersion(2)).toMatchObject({ code: "PROTOCOL_UNSUPPORTED", ok: false });
    });

    it.each([
        ["{"],
        ["[]"],
        ['{"type":"pong"}'],
        ['{"type":"hello"}'],
        ['{"type":"hello","protocol":"1"}'],
        ['{"type":"hello","protocol":0}'],
        ['{"type":"hello","protocol":1.5}'],
    ])("peeks no version from %s", (frame) => {
        expect(peekProtocolVersion(frame)).toBeUndefined();
    });

    it("peeks the version of a valid hello", () => {
        expect(peekProtocolVersion(JSON.stringify(fixtures.box.hello))).toBe(HOSTD_PROTOCOL_VERSION);
    });

    it("produces an error frame that decodes", () => {
        const { code, message } = negotiateProtocolVersion(99) as Extract<ProtocolNegotiation, { ok: false }>;

        expect(decodeCloudMessage(encodeMessage({ code, message, type: "error" }))).toStrictEqual({ message: { code, message, type: "error" }, ok: true });
    });
});

describe("signing payloads", () => {
    it("builds the golden challenge payload", () => {
        expect(text(challengeSigningPayload(NONCE, BOX_ID))).toBe(fixtures.signing.challenge.payload);
    });

    it("builds the golden request payloads", () => {
        const { payload, ...input } = fixtures.signing.request;
        const { payload: payloadWithoutTimestamp, ...inputWithoutTimestamp } = fixtures.signing["request-without-timestamp"];

        expect(text(requestSigningPayload(input))).toBe(payload);
        expect(text(requestSigningPayload(inputWithoutTimestamp))).toBe(payloadWithoutTimestamp);
    });

    it("is deterministic", () => {
        expect(challengeSigningPayload(NONCE, BOX_ID)).toStrictEqual(challengeSigningPayload(NONCE, BOX_ID));
        expect(requestSigningPayload(fixtures.signing.request)).toStrictEqual(requestSigningPayload(fixtures.signing.request));
    });

    it("separates the two domains", () => {
        const challenge = text(challengeSigningPayload(NONCE, BOX_ID));
        const request = text(requestSigningPayload({ boxId: BOX_ID, method: "GET", nonce: NONCE, path: "/" }));

        expect(challenge.startsWith(`${HOSTD_AUTH_DOMAIN}:`)).toBe(true);
        expect(request.startsWith(`${HOSTD_REQUEST_DOMAIN}\n`)).toBe(true);
        expect(challenge).not.toBe(request);
        expect(HOSTD_AUTH_DOMAIN.startsWith(HOSTD_REQUEST_DOMAIN)).toBe(false);
        expect(HOSTD_REQUEST_DOMAIN.startsWith(HOSTD_AUTH_DOMAIN)).toBe(false);
    });

    it("binds every input", () => {
        const base = { boxId: BOX_ID, method: "GET", nonce: NONCE, path: "/v1/boxes/releases/dep_1", timestamp: 1 };
        const payloads = [
            base,
            { ...base, boxId: "box_other" },
            { ...base, method: "POST" },
            { ...base, nonce: `${NONCE}A` },
            { ...base, path: "/v1/boxes/releases/dep_2" },
            { ...base, timestamp: 2 },
            { ...base, timestamp: undefined },
        ].map((input) => text(requestSigningPayload(input)));

        expect(new Set(payloads).size).toBe(payloads.length);
        expect(text(challengeSigningPayload(NONCE, "box_a"))).not.toBe(text(challengeSigningPayload(NONCE, "box_b")));
        expect(text(challengeSigningPayload(NONCE, BOX_ID))).not.toBe(text(challengeSigningPayload(`${NONCE}A`, BOX_ID)));
    });

    it("refuses inputs that could make two payloads collide", () => {
        expect(() => challengeSigningPayload(NONCE, "box:1")).toThrow(TypeError);
        expect(() => challengeSigningPayload("short", BOX_ID)).toThrow(TypeError);
        expect(() => challengeSigningPayload(`${NONCE}:x`, BOX_ID)).toThrow(TypeError);
        expect(() => requestSigningPayload({ boxId: BOX_ID, method: "get", nonce: NONCE, path: "/" })).toThrow(TypeError);
        expect(() => requestSigningPayload({ boxId: BOX_ID, method: "GET", nonce: NONCE, path: "/a\nb" })).toThrow(TypeError);
        expect(() => requestSigningPayload({ boxId: BOX_ID, method: "GET", nonce: NONCE, path: "relative" })).toThrow(TypeError);
        expect(() => requestSigningPayload({ boxId: BOX_ID, method: "GET", nonce: NONCE, path: "/a#frag" })).toThrow(TypeError);
        expect(() => requestSigningPayload({ boxId: BOX_ID, method: "GET", nonce: NONCE, path: "/", timestamp: -1 })).toThrow(TypeError);
        expect(() => requestSigningPayload({ boxId: BOX_ID, method: "GET", nonce: NONCE, path: "/", timestamp: 1.5 })).toThrow(TypeError);
    });
});
