/* eslint-disable sonarjs/no-hardcoded-ip -- the subject under test is which IP addresses a box may publish; every literal is a fixture */
import { describe, expect, it } from "vitest";

import { authorizeDiagnose, createEnrolment, enrol, get, list, rename, revoke } from "../lunora/boxes";
import { isPublicIpv4, isPublicIpv6 } from "../src/boxes/addresses";
import { fromBase64Url, isBoxPublicKey, toBase64Url, verifyBoxSignature } from "../src/boxes/encoding";
import { isEnrolmentTokenShape, mintBoxSlug } from "../src/boxes/enrolment";
import { sha256Hex } from "../src/deploy/keys";
import type { FakeCtx, Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

const NOW = 1_700_000_000_000;

/** Stored hostd releases: an older and a newer stable one, and a newer canary that enrolment must skip. */
const RELEASES = [
    { _id: "rel_1", channel: "stable", createdAt: 1, releaseId: "hostd-v1_1_0", versions: { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.1.0" } },
    { _id: "rel_2", createdAt: 2, releaseId: "hostd-v1_2_0", versions: { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.2.0" } },
    { _id: "rel_3", channel: "canary", createdAt: 3, releaseId: "hostd-v1_3_0", versions: { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.3.0" } },
];

/** A real Ed25519 key pair, the way `hostd enrol` makes one. */
const keyPair = async (): Promise<{ privateKey: CryptoKey; publicKey: string }> => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
};

const PUBLIC_KEY = toBase64Url(new Uint8Array(32).fill(7));

/** An active pro subscription: 3 boxes (`src/billing/plans.ts`). */
const PRO = [{ _id: "sub_1", priceId: "price_pro_monthly", provider: "creem", referenceId: "org_1", state: "active" }];
const VERSIONS = { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.0.0" };

const enrolArgs = (hashedToken: string, overrides: Record<string, unknown> = {}) => {
    return { hashedToken, ipv4: "203.0.113.9", publicKey: PUBLIC_KEY, singleTrust: false, versions: VERSIONS, ...overrides };
};

const box = (overrides: Row = {}): Row => {
    return {
        _id: "box_1",
        createdAt: NOW,
        name: "edge",
        organizationId: "org_1",
        publicKey: PUBLIC_KEY,
        singleTrust: false,
        slug: "babcdefghij",
        status: "online",
        ...overrides,
    };
};

describe("box identity encoding", () => {
    it("round-trips base64url and recognises a raw Ed25519 key", () => {
        const bytes = Uint8Array.from({ length: 32 }, (_, index) => index * 7);

        expect(fromBase64Url(toBase64Url(bytes))).toStrictEqual(bytes);
        expect(isBoxPublicKey(toBase64Url(bytes))).toBe(true);
        expect(isBoxPublicKey(toBase64Url(bytes.slice(0, 31)))).toBe(false);
        expect(isBoxPublicKey("not a key")).toBe(false);
        expect(fromBase64Url("a")).toBeNull();
        expect(fromBase64Url("+/==")).toBeNull();
    });

    it("verifies a box signature with WebCrypto, and refuses a forged or malformed one", async () => {
        const { privateKey, publicKey } = await keyPair();
        const other = await keyPair();
        const payload = new TextEncoder().encode("lunora-hostd-auth:v1:box_1:nonce");
        const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, payload)));

        await expect(verifyBoxSignature(publicKey, signature, payload)).resolves.toBe(true);
        await expect(verifyBoxSignature(other.publicKey, signature, payload)).resolves.toBe(false);
        await expect(verifyBoxSignature(publicKey, signature, new TextEncoder().encode("something else"))).resolves.toBe(false);
        await expect(verifyBoxSignature(publicKey, "short", payload)).resolves.toBe(false);
        await expect(verifyBoxSignature("nope", signature, payload)).resolves.toBe(false);
    });

    it("mints random DNS-safe slugs and recognisable tokens", () => {
        const slugs = new Set(Array.from({ length: 50 }, () => mintBoxSlug()));

        expect(slugs.size).toBe(50);
        expect([...slugs].every((slug) => /^b[a-z\d]{10}$/u.test(slug))).toBe(true);
        expect(isEnrolmentTokenShape(`lbe_${"a".repeat(64)}`)).toBe(true);
        expect(isEnrolmentTokenShape("lbe_short")).toBe(false);
    });
});

describe("box addresses", () => {
    it.each(["203.0.113.9", "8.8.8.8", "1.1.1.1"])("accepts the public IPv4 %s", (address) => {
        expect(isPublicIpv4(address)).toBe(true);
    });

    it.each([
        "10.0.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.5.4",
        "192.168.1.1",
        "100.64.0.1",
        "0.1.2.3",
        "224.0.0.1",
        "255.255.255.255",
        "1.2.3",
        "01.2.3.4",
    ])("refuses the non-public or malformed IPv4 %s", (address) => {
        expect(isPublicIpv4(address)).toBe(false);
    });

    it.each(["2606:4700::1111", "2a01:4f8:c17:1::1", "2001:4860:4860::8888"])("accepts the global unicast IPv6 %s", (address) => {
        expect(isPublicIpv6(address)).toBe(true);
    });

    it.each(["::1", "::", "fe80::1", "fd00::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "2606:4700::1::1", "nonsense"])(
        "refuses the IPv6 %s",
        (address) => {
            expect(isPublicIpv6(address)).toBe(false);
        },
    );
});

describe("boxes.createEnrolment", () => {
    /** The action's ctx: the mutation double plus the env it reads its origin from. */
    const withOrigin = ({ ctx, ops }: FakeCtx, origin: null | string = "https://cloud.lunora.test/"): FakeCtx => {
        return { ctx: { ...ctx, env: origin === null ? {} : { LUNORA_ORIGIN_URL: origin } }, ops };
    };

    it("returns the token once and stores only its hash, valid for 15 minutes", async () => {
        const { ctx, ops } = withOrigin(
            makeCtx({ boxEnrolments: [], boxes: [], hostdReleases: RELEASES, members: [owner("org_1")], subscriptions: PRO }, { now: NOW }),
        );

        const result = await createEnrolment.handler(ctx, { name: " edge ", organizationId: "org_1" as never });

        expect(isEnrolmentTokenShape(result.token)).toBe(true);
        // install.sh of the newest STABLE release (not the newer canary), enrolling with this control
        // plane's own origin; the token rides in the environment, the bucket stays the customer's.
        expect(result.installCommand.split("\n")).toStrictEqual([
            "curl -fsSLO https://github.com/anolilab/lunora/releases/download/hostd-v1.2.0/install.sh",
            "sha256sum install.sh   # compare with the release notes",
            // eslint-disable-next-line no-secrets/no-secrets -- env-var NAMES and placeholders, not a credential
            `sudo LUNORA_HOSTD_ENROL_TOKEN=${result.token} AWS_ACCESS_KEY_ID=<bucket key id> AWS_SECRET_ACCESS_KEY=<bucket secret> \\`,
            "    bash install.sh --control-plane https://cloud.lunora.test --bucket <bucket> --version 1.2.0",
        ]);
        expect(result.expiresAt).toBe(NOW + 15 * 60 * 1000);

        const stored = ops.find((op) => op.kind === "insert" && op.table === "boxEnrolments");

        expect(stored).toMatchObject({ document: { createdBy: "usr_1", hashedToken: await sha256Hex(result.token), name: "edge", organizationId: "org_1" } });
        expect(JSON.stringify(ops)).not.toContain(result.token);
        expect(ops.some((op) => op.kind === "insert" && op.table === "auditLog")).toBe(true);
    });

    it("counts live boxes and unused tokens against the plan's boxes limit", async () => {
        const live = [box({ _id: "b1" }), box({ _id: "b2" }), box({ _id: "b3", status: "revoked" })];
        const unused = { _id: "e1", expiresAt: NOW + 60_000, organizationId: "org_1" };
        const expired = { _id: "e2", expiresAt: NOW - 1, organizationId: "org_1" };
        const { ctx } = withOrigin(makeCtx({ boxEnrolments: [unused, expired], boxes: live, members: [owner("org_1")], subscriptions: PRO }, { now: NOW }));

        await expect(createEnrolment.handler(ctx, { name: "fourth", organizationId: "org_1" as never })).rejects.toThrow(
            "boxes quota reached for this plan (limit 3)",
        );
    });

    it("gives the free plan no boxes", async () => {
        const { ctx } = withOrigin(makeCtx({ boxEnrolments: [], boxes: [], members: [owner("org_1")], subscriptions: [] }, { now: NOW }));

        await expect(createEnrolment.handler(ctx, { name: "edge", organizationId: "org_1" as never })).rejects.toThrow("(limit 0)");
    });

    it("refuses a plain member", async () => {
        const { ctx } = withOrigin(makeCtx({ members: [{ ...owner("org_1"), role: "member" }] }));

        await expect(createEnrolment.handler(ctx, { name: "edge", organizationId: "org_1" as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("mints nothing while the control plane offers no hostd release to install", async () => {
        const { ctx, ops } = withOrigin(
            makeCtx({ boxEnrolments: [], boxes: [], hostdReleases: [], members: [owner("org_1")], subscriptions: PRO }, { now: NOW }),
        );

        await expect(createEnrolment.handler(ctx, { name: "edge", organizationId: "org_1" as never })).rejects.toMatchObject({
            code: "SERVICE_UNAVAILABLE",
            message: expect.stringContaining("no lunora-hostd release") as unknown,
        });
        expect(ops.filter((op) => op.kind === "insert" && op.table === "boxEnrolments")).toStrictEqual([]);
    });

    it("mints nothing on a control plane that does not know its own origin", async () => {
        const { ctx, ops } = withOrigin(makeCtx({ boxEnrolments: [], boxes: [], members: [owner("org_1")], subscriptions: PRO }, { now: NOW }), null);

        await expect(createEnrolment.handler(ctx, { name: "edge", organizationId: "org_1" as never })).rejects.toMatchObject({
            code: "SERVICE_UNAVAILABLE",
            message: expect.stringContaining("LUNORA_ORIGIN_URL") as unknown,
        });
        expect(ops.filter((op) => op.kind === "insert" && op.table === "boxEnrolments")).toStrictEqual([]);
    });
});

describe("boxes.authorizeDiagnose", () => {
    it("clears an owner's diagnose of a live box, audited", async () => {
        const { ctx, ops } = makeCtx({ boxes: [box()], members: [owner("org_1")] }, { now: NOW });

        await expect(authorizeDiagnose.handler(ctx, { id: "box_1" as never, organizationId: "org_1" as never })).resolves.toStrictEqual({
            slug: "babcdefghij",
        });
        expect(ops).toContainEqual({
            document: { action: "box.diagnose", actorUserId: "usr_1", createdAt: NOW, organizationId: "org_1", target: "babcdefghij" },
            kind: "insert",
            table: "auditLog",
        });
    });

    it("refuses a plain member, another org's box and a revoked box", async () => {
        const member = makeCtx({ boxes: [box()], members: [{ ...owner("org_1"), role: "member" }] }).ctx;
        const stranger = makeCtx({ boxes: [box({ organizationId: "org_2" })], members: [owner("org_1")] }).ctx;
        const revoked = makeCtx({ boxes: [box({ status: "revoked" })], members: [owner("org_1")] }).ctx;
        const args = { id: "box_1" as never, organizationId: "org_1" as never };

        await expect(authorizeDiagnose.handler(member, args)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(authorizeDiagnose.handler(stranger, args)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(authorizeDiagnose.handler(revoked, args)).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("is internal: only POST /v1/boxes/diagnose, which holds the box's session, may call it", () => {
        expect(authorizeDiagnose.visibility).toBe("internal");
    });
});

describe("boxes.enrol", () => {
    const enrolment = async (overrides: Row = {}): Promise<Row> => {
        return {
            _id: "enr_1",
            createdAt: NOW,
            createdBy: "usr_1",
            expiresAt: NOW + 60_000,
            hashedToken: await sha256Hex("token"),
            name: "edge",
            organizationId: "org_1",
            ...overrides,
        };
    };

    it("consumes a fresh token: creates a pending box in the token's org and marks the token used", async () => {
        const row = await enrolment();
        const { ctx, ops } = makeCtx({ boxEnrolments: [row], boxes: [], subscriptions: PRO }, { now: NOW });

        const result = await enrol.handler(ctx, enrolArgs(row.hashedToken as string));

        expect(result).toMatchObject({ boxId: "boxes_new", created: true, ipv4: "203.0.113.9", organizationId: "org_1" });
        expect(result.slug).toMatch(/^b[a-z\d]{10}$/u);
        expect(ops).toContainEqual(
            expect.objectContaining({
                document: expect.objectContaining({ organizationId: "org_1", publicKey: PUBLIC_KEY, status: "pending", versions: VERSIONS }) as unknown,
                kind: "insert",
                table: "boxes",
            }),
        );
        expect(ops).toContainEqual({ id: "enr_1", kind: "patch", patch: { boxId: "boxes_new", usedAt: NOW } });
    });

    it("answers a retry with the same key with the box it already created, and refuses a replay with another key", async () => {
        const row = await enrolment({ boxId: "box_1", usedAt: NOW - 1000 });
        const { ctx, ops } = makeCtx({ boxEnrolments: [row], boxes: [box({ ipv4: "203.0.113.9", status: "pending" })] }, { now: NOW });

        await expect(enrol.handler(ctx, enrolArgs(row.hashedToken as string))).resolves.toMatchObject({ boxId: "box_1", created: false, slug: "babcdefghij" });
        await expect(enrol.handler(ctx, enrolArgs(row.hashedToken as string, { publicKey: toBase64Url(new Uint8Array(32).fill(9)) }))).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(ops.filter((op) => op.kind === "insert" && op.table === "boxes")).toStrictEqual([]);
    });

    it("re-checks the limit when the token is consumed", async () => {
        const row = await enrolment();
        const { ctx, ops } = makeCtx({ boxEnrolments: [row], boxes: [box({ _id: "b1" })], subscriptions: [] }, { now: NOW });

        await expect(enrol.handler(ctx, enrolArgs(row.hashedToken as string))).rejects.toThrow("boxes quota reached");
        expect(ops).toStrictEqual([]);
    });

    it("refuses an expired or unknown token without saying which", async () => {
        const row = await enrolment({ expiresAt: NOW });
        const { ctx } = makeCtx({ boxEnrolments: [row] }, { now: NOW });

        await expect(enrol.handler(ctx, enrolArgs(row.hashedToken as string))).rejects.toThrow("invalid or expired enrolment token");
        await expect(enrol.handler(ctx, enrolArgs("0".repeat(64)))).rejects.toThrow("invalid or expired enrolment token");
    });

    it.each([
        [{ publicKey: "not-a-key" }, "publicKey"],
        [{ ipv4: "10.0.0.1" }, "ipv4"],
        [{ ipv4: undefined, ipv6: "fe80::1" }, "ipv6"],
        [{ ipv4: undefined }, "public IPv4 or IPv6"],
        [{ versions: { ...VERSIONS, celld: "v 1" } }, "versions"],
    ])("refuses a malformed enrolment %o before touching the token", async (overrides, message) => {
        const row = await enrolment();
        const { ctx, ops } = makeCtx({ boxEnrolments: [row] }, { now: NOW });

        await expect(enrol.handler(ctx, enrolArgs(row.hashedToken as string, overrides))).rejects.toThrow(message);
        expect(ops).toStrictEqual([]);
    });
});

describe("boxes reads and writes are org-scoped", () => {
    it("lists only the caller's boxes and drops unset (NULL) columns", async () => {
        const { ctx } = makeCtx({
            boxes: [box({ dnsError: null }), box({ _id: "box_2", organizationId: "org_2" })],
            hostdReleases: [],
            members: [owner("org_1")],
        });

        const boxes = await list.handler(ctx, { organizationId: "org_1" as never });

        expect(boxes.map((row) => row._id)).toStrictEqual(["box_1"]);
        expect(boxes[0]).not.toHaveProperty("dnsError");
    });

    it("answers null for another org's box", async () => {
        const { ctx } = makeCtx({ boxes: [box({ organizationId: "org_2" })], hostdReleases: [], members: [owner("org_1")] });

        await expect(get.handler(ctx, { id: "box_1" as never, organizationId: "org_1" as never })).resolves.toBeNull();
    });

    it.each([
        ["rename", (ctx: Parameters<typeof rename.handler>[0]) => rename.handler(ctx, { id: "box_1" as never, name: "x", organizationId: "org_1" as never })],
        ["revoke", (ctx: Parameters<typeof revoke.handler>[0]) => revoke.handler(ctx, { id: "box_1" as never, organizationId: "org_1" as never })],
    ])("refuses to %s another org's box", async (_name, call) => {
        const { ctx, ops } = makeCtx({ boxes: [box({ organizationId: "org_2" })], members: [owner("org_1")] });

        await expect(call(ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(ops.filter((op) => op.kind !== "insert" || op.table !== "rateLimits")).toStrictEqual([]);
    });

    it("revokes once, audited, and answers what the route needs to clean up", async () => {
        const { ctx, ops } = makeCtx({ boxes: [box({ ipv4: "203.0.113.9" })], members: [owner("org_1")] }, { now: NOW });

        await expect(revoke.handler(ctx, { id: "box_1" as never, organizationId: "org_1" as never })).resolves.toStrictEqual({
            ipv4: "203.0.113.9",
            slug: "babcdefghij",
        });
        expect(ops).toContainEqual({ id: "box_1", kind: "patch", patch: { revokedAt: NOW, status: "revoked" } });
    });

    it("is internal: only POST /v1/boxes/revoke, which also closes the session and removes the DNS records, may call it", () => {
        expect(revoke.visibility).toBe("internal");
    });

    it("does not re-revoke a revoked box", async () => {
        const { ctx, ops } = makeCtx({ boxes: [box({ status: "revoked" })], members: [owner("org_1")] });

        await revoke.handler(ctx, { id: "box_1" as never, organizationId: "org_1" as never });

        expect(ops.filter((op) => op.kind === "patch")).toStrictEqual([]);
    });
});
