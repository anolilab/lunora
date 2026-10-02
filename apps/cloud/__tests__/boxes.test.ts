/* eslint-disable sonarjs/no-hardcoded-ip -- the subject under test is which IP addresses a box may publish; every literal is a fixture */
import { describe, expect, it } from "vitest";

import { createEnrolment, enrol, get, list, rename, revoke, setProjectTarget } from "../lunora/boxes";
import { isPublicIpv4, isPublicIpv6 } from "../src/boxes/addresses";
import { fromBase64Url, isBoxPublicKey, toBase64Url, verifyBoxSignature } from "../src/boxes/encoding";
import { isEnrolmentTokenShape, mintBoxSlug } from "../src/boxes/enrolment";
import { sha256Hex } from "../src/deploy/keys";
import type { Row } from "./_helpers/fake-ctx";
import { makeCtx, owner } from "./_helpers/fake-ctx";

const NOW = 1_700_000_000_000;

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
    it("returns the token once and stores only its hash, valid for 15 minutes", async () => {
        const { ctx, ops } = makeCtx({ boxEnrolments: [], boxes: [], members: [owner("org_1")], subscriptions: PRO }, { now: NOW });

        const result = await createEnrolment.handler(ctx, { name: " edge ", organizationId: "org_1" as never });

        expect(isEnrolmentTokenShape(result.token)).toBe(true);
        expect(result.installCommand).toBe(`sudo lunora-hostd enrol --token ${result.token}`);
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
        const { ctx } = makeCtx({ boxEnrolments: [unused, expired], boxes: live, members: [owner("org_1")], subscriptions: PRO }, { now: NOW });

        await expect(createEnrolment.handler(ctx, { name: "fourth", organizationId: "org_1" as never })).rejects.toThrow(
            "boxes quota reached for this plan (limit 3)",
        );
    });

    it("gives the free plan no boxes", async () => {
        const { ctx } = makeCtx({ boxEnrolments: [], boxes: [], members: [owner("org_1")], subscriptions: [] }, { now: NOW });

        await expect(createEnrolment.handler(ctx, { name: "edge", organizationId: "org_1" as never })).rejects.toThrow("(limit 0)");
    });

    it("refuses a plain member", async () => {
        const { ctx } = makeCtx({ members: [{ ...owner("org_1"), role: "member" }] });

        await expect(createEnrolment.handler(ctx, { name: "edge", organizationId: "org_1" as never })).rejects.toMatchObject({ code: "FORBIDDEN" });
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
        const { ctx } = makeCtx({ boxes: [box({ dnsError: null }), box({ _id: "box_2", organizationId: "org_2" })], members: [owner("org_1")] });

        const boxes = await list.handler(ctx, { organizationId: "org_1" as never });

        expect(boxes.map((row) => row._id)).toStrictEqual(["box_1"]);
        expect(boxes[0]).not.toHaveProperty("dnsError");
    });

    it("answers null for another org's box", async () => {
        const { ctx } = makeCtx({ boxes: [box({ organizationId: "org_2" })], members: [owner("org_1")] });

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

    it("does not re-revoke a revoked box", async () => {
        const { ctx, ops } = makeCtx({ boxes: [box({ status: "revoked" })], members: [owner("org_1")] });

        await revoke.handler(ctx, { id: "box_1" as never, organizationId: "org_1" as never });

        expect(ops.filter((op) => op.kind === "patch")).toStrictEqual([]);
    });
});

describe("boxes.setProjectTarget", () => {
    const project = (overrides: Row = {}): Row => {
        return { _id: "proj_1", name: "web", organizationId: "org_1", slug: "web", ...overrides };
    };

    const call = (tables: Record<string, Row[]>, args: Record<string, unknown>) => {
        const fake = makeCtx({ members: [owner("org_1")], projects: [project()], ...tables }, { now: NOW });

        return {
            ops: fake.ops,
            run: () => setProjectTarget.handler(fake.ctx, { organizationId: "org_1" as never, projectId: "proj_1" as never, ...args } as never),
        };
    };

    it("places a project on a box of its own org", async () => {
        const { ops, run } = call({ boxes: [box()], deployments: [] }, { boxId: "box_1", target: "celld-vps" });

        await run();

        expect(ops).toContainEqual({ id: "proj_1", kind: "patch", patch: { boxId: "box_1", target: "celld-vps" } });
    });

    it("requires a box for celld-vps and refuses one for cloudflare-wfp", async () => {
        await expect(call({ boxes: [box()] }, { target: "celld-vps" }).run()).rejects.toThrow("needs a box");
        await expect(call({ boxes: [box()] }, { boxId: "box_1", target: "cloudflare-wfp" }).run()).rejects.toThrow("has no box");
    });

    it("refuses another org's box and a revoked box", async () => {
        await expect(call({ boxes: [box({ organizationId: "org_2" })] }, { boxId: "box_1", target: "celld-vps" }).run()).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        await expect(call({ boxes: [box({ status: "revoked" })] }, { boxId: "box_1", target: "celld-vps" }).run()).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });

    it("refuses to move a project whose deployments are not torn down yet", async () => {
        const { ops, run } = call(
            { boxes: [box()], deployments: [{ _id: "dep_1", projectId: "proj_1", status: "destroyed", teardownAt: null }] },
            { boxId: "box_1", target: "celld-vps" },
        );

        await expect(run()).rejects.toMatchObject({ code: "CONFLICT" });
        expect(ops.filter((op) => op.kind === "patch")).toStrictEqual([]);
    });

    it("moves a project back to cloudflare-wfp and clears its box", async () => {
        const { ops, run } = call(
            {
                deployments: [{ _id: "dep_1", projectId: "proj_1", status: "destroyed", teardownAt: NOW }],
                projects: [project({ boxId: "box_1", target: "celld-vps" })],
            },
            { target: "cloudflare-wfp" },
        );

        await run();

        expect(ops).toContainEqual({ id: "proj_1", kind: "patch", patch: { boxId: null, target: "cloudflare-wfp" } });
    });
});
