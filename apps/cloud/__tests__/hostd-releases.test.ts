import { generateKeyPairSync } from "node:crypto";

import type { HostdReleaseManifest } from "@lunora/hostd/release";
import { signReleaseManifest } from "@lunora/hostd/release/verify";
import { describe, expect, it } from "vitest";

import { list, setDesiredRelease } from "../lunora/boxes";
import { store } from "../lunora/hostd-releases";
import { randomBase64Url } from "../src/boxes/encoding";
import { verifyReleaseEnvelope, versionKey, versionsOf } from "../src/boxes/hostd-releases";
import { rolloutHostdRelease } from "../src/boxes/rollout";
import { handleHostdManifestRoute, handleHostdReleaseRoute } from "../src/deploy/routes/hostd";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { makeCtx, owner } from "./_helpers/fake-ctx";
import { boxKey, boxRow, fakeState, handshake, namespaceOver, signedHeaders, TestBoxSession } from "./support/box-session-fakes";
import { memoryStore } from "./support/memory-store";

const artifact = (platform: "linux-arm64" | "linux-x64", component: string) => {
    return { platform, sha256: "a".repeat(64), size: 1024, url: `https://example.com/${component}-${platform}` };
};

const manifest = (overrides: Partial<HostdReleaseManifest> = {}): HostdReleaseManifest => {
    return {
        caddy: { artifacts: [artifact("linux-x64", "caddy")], modules: ["github.com/mholt/caddy-ratelimit"], version: "v2.11.6" },
        celld: { artifacts: [{ ...artifact("linux-x64", "celld"), compression: "gzip" }], version: "v0.7.0" },
        createdAt: "2026-10-02T12:00:00.000Z",
        hostd: { artifacts: [artifact("linux-x64", "hostd")], version: "1.1.0" },
        releaseId: "hostd-v1_1_0",
        schema: 1,
        ...overrides,
    };
};

/** A release signed by a fresh key, with that key as the only trusted one. */
const signedRelease = (overrides: Partial<HostdReleaseManifest> = {}) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const envelope = signReleaseManifest(manifest(overrides), privateKey);

    return { envelope, trusted: { [envelope.keyId]: publicKey.export({ format: "pem", type: "spki" }) } };
};

describe("verifying a release envelope in the Worker", () => {
    it("accepts what the reference signer signed, checked with WebCrypto", async () => {
        const { envelope, trusted } = signedRelease();

        await expect(verifyReleaseEnvelope(structuredClone(envelope), trusted)).resolves.toStrictEqual({ envelope, ok: true });
    });

    it("refuses a tampered manifest", async () => {
        const { envelope, trusted } = signedRelease();
        const tampered = structuredClone(envelope);

        tampered.manifest.celld.version = "v9.9.9";

        await expect(verifyReleaseEnvelope(tampered, trusted)).resolves.toStrictEqual({ ok: false, reason: "the release signature does not verify" });
    });

    it("refuses a key it does not pin — never one the envelope brings", async () => {
        const { envelope } = signedRelease();

        await expect(verifyReleaseEnvelope(envelope, signedRelease().trusted)).resolves.toMatchObject({
            ok: false,
            reason: expect.stringContaining("not one this control plane trusts") as string,
        });
    });

    it("refuses everything signed under the placeholder the pinned set still holds", async () => {
        const { envelope } = signedRelease();

        await expect(verifyReleaseEnvelope({ ...envelope, keyId: "ed25519-placeholder" })).resolves.toMatchObject({
            ok: false,
            reason: expect.stringContaining("placeholder") as string,
        });
    });

    it("refuses an invalid envelope and a trusted entry that is not a key", async () => {
        const { envelope, trusted } = signedRelease();

        await expect(verifyReleaseEnvelope({ ...envelope, extra: true }, trusted)).resolves.toMatchObject({
            ok: false,
            reason: expect.stringContaining("invalid release envelope") as string,
        });
        await expect(verifyReleaseEnvelope(envelope, { [envelope.keyId]: "not a pem" })).resolves.toMatchObject({
            ok: false,
            reason: expect.stringContaining("not an SPKI PEM") as string,
        });
    });
});

describe("the hostd release store", () => {
    const args = { envelope: "{}", keyId: "ed25519-x", releaseId: "hostd-v1_1_0", versions: { caddy: "v2", celld: "v0.7.0", hostd: "1.1.0" } };

    it("stores a release once, and refuses different bytes under the same id", async () => {
        const fresh = makeCtx({ hostdReleases: [] });

        await expect(store.handler(fresh.ctx, args)).resolves.toStrictEqual({ created: true });

        const stored = makeCtx({ hostdReleases: [{ _id: "rel_1", createdAt: 1, ...args }] });

        await expect(store.handler(stored.ctx, args)).resolves.toStrictEqual({ created: false });
        await expect(store.handler(stored.ctx, { ...args, envelope: '{"other":1}' })).rejects.toMatchObject({ code: "CONFLICT" });
    });
});

describe("the release routes", () => {
    it("refuses to store a release without the admin token, and refuses the placeholder key with it", async () => {
        const { envelope } = signedRelease();
        const post = (headers: Record<string, string>) =>
            handleHostdReleaseRoute(
                new Request("https://cloud.test/v1/hostd/releases", {
                    body: JSON.stringify({ envelope: { ...envelope, keyId: "ed25519-placeholder" } }),
                    headers,
                    method: "POST",
                }),
                {
                    __lunoraCtx: makeCtx({}).ctx as never,
                    LUNORA_ADMIN_TOKEN: "admin",
                },
            );

        await expect(post({})).resolves.toMatchObject({ status: 401 });

        const response = await post({ authorization: "Bearer admin" });

        expect(response.status).toBe(422);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("placeholder") as string });
    });

    it("serves the stored envelope to a box that signed its request, and nothing to one that did not", async () => {
        const key = await boxKey();
        const session = new TestBoxSession(fakeState(), memoryStore());
        const path = "/v1/hostd/releases/hostd-v1_1_0/manifest";
        const envelopes = new Map([["hostd-v1_1_0", '{"signed":true}']]);
        const environment: RouterEnv & { BOX_SESSION: ReturnType<typeof namespaceOver> } = {
            __lunoraCtx: {
                runAction: () => Promise.reject(new Error("unused")),
                runMutation: () => Promise.reject(new Error("unused")),
                runQuery: <R>(_reference: unknown, args: Record<string, unknown> = {}) =>
                    Promise.resolve(
                        ("releaseId" in args
                            ? (envelopes.get(args["releaseId"] as string) ?? null)
                            : { organizationId: "org_1", publicKey: key.publicKey, revoked: false, slug: "b" }) as R,
                    ),
            },
            BOX_SESSION: namespaceOver(session),
        };
        const signed = async () =>
            new Request(`https://cloud.test${path}`, {
                headers: await signedHeaders(key, { boxId: "box_1", method: "GET", nonce: randomBase64Url(), path, timestamp: Date.now() }),
            });

        const response = await handleHostdManifestRoute(await signed(), environment);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe('{"signed":true}');
        await expect(handleHostdManifestRoute(new Request(`https://cloud.test${path}`), environment)).resolves.toMatchObject({ status: 401 });
    });
});

describe("rolling a release out", () => {
    const release = { releaseId: "hostd-v1_1_0", versions: { caddy: "v2.11.6", celld: "v0.7.0", hostd: "1.1.0" } };
    const old = { caddy: "v2.11.6", celld: "v0.6.0", hostd: "1.0.0" };

    it("upgrades online boxes canary first, skips current ones, and defers offline ones to their reconnect", async () => {
        const dispatched: string[] = [];
        const result = await rolloutHostdRelease({
            boxes: [
                { boxId: "box_a", status: "online", versions: old },
                { boxId: "box_b", status: "online", versions: old },
                { boxId: "box_c", status: "online", versions: release.versions },
                { boxId: "box_d", status: "offline", versions: old },
            ],
            dispatch: (boxId, job) => {
                dispatched.push(`${boxId} ${job.kind} ${job.releaseId} ${job.manifestUrl}`);

                return Promise.resolve({ ok: true });
            },
            manifestUrl: "https://cloud.test/v1/hostd/releases/hostd-v1_1_0/manifest",
            release,
        });

        expect(result).toStrictEqual({ deferred: 1, failed: 0, halted: false, released: 2, remaining: 0, skipped: 1 });
        expect(dispatched).toStrictEqual([
            "box_a upgrade hostd-v1_1_0 https://cloud.test/v1/hostd/releases/hostd-v1_1_0/manifest",
            "box_b upgrade hostd-v1_1_0 https://cloud.test/v1/hostd/releases/hostd-v1_1_0/manifest",
        ]);
    });

    it("halts when the canary fails", async () => {
        const result = await rolloutHostdRelease({
            boxes: [
                { boxId: "box_a", status: "online", versions: old },
                { boxId: "box_b", status: "online", versions: old },
            ],
            dispatch: () => Promise.resolve({ error: { code: "CHECKSUM", message: "bad" }, ok: false }),
            manifestUrl: "https://cloud.test/m",
            release,
        });

        expect(result).toMatchObject({ failed: 1, halted: true, released: 0, remaining: 1 });
    });

    it("points boxes at a stored release, never a revoked one", async () => {
        const { ctx, ops } = makeCtx({
            boxes: [
                boxRow({ publicKey: "" } as never, { _id: "box_1", status: "online" }),
                boxRow({ publicKey: "" } as never, { _id: "box_2", status: "revoked" }),
            ],
            hostdReleases: [{ _id: "rel_1", releaseId: "hostd-v1_1_0" }],
        });

        await expect(setDesiredRelease.handler(ctx, { releaseId: "hostd-v1_1_0" })).resolves.toStrictEqual([{ boxId: "box_1", status: "online" }]);
        expect(ops).toStrictEqual([{ id: "box_1", kind: "patch", patch: { desiredReleaseId: "hostd-v1_1_0" } }]);
        await expect(setDesiredRelease.handler(ctx, { releaseId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("hands a reconnecting box the upgrade it missed", async () => {
        const key = await boxKey();
        const { envelope } = signedRelease();
        const records = memoryStore({
            boxes: [boxRow(key, { desiredReleaseId: "hostd-v1_1_0" })],
            hostdReleases: [{ _id: "rel_1", envelope: JSON.stringify(envelope), releaseId: "hostd-v1_1_0", versions: versionsOf(envelope) }],
            projects: [],
        });
        const state = fakeState();
        const socket = await handshake(new TestBoxSession(state, records, { LUNORA_ORIGIN_URL: "https://cloud.test/" }), state, key, "box_1");

        expect(socket.received().at(-1)).toMatchObject({
            job: { kind: "upgrade", manifestUrl: "https://cloud.test/v1/hostd/releases/hostd-v1_1_0/manifest", releaseId: "hostd-v1_1_0" },
            type: "job",
        });
        expect(versionKey(versionsOf(envelope))).toBe("hostd 1.1.0 / celld v0.7.0 / caddy v2.11.6");
    });
});

describe("outdated boxes", () => {
    it("flags a box whose celld is not the newest stable release's", async () => {
        const key = await boxKey();
        const { ctx } = makeCtx({
            boxes: [
                boxRow(key, { _id: "box_old", versions: { caddy: "v2", celld: "v0.6.0", hostd: "1.0.0" } }),
                boxRow(key, { _id: "box_new", versions: { caddy: "v2", celld: "v0.7.0", hostd: "1.1.0" } }),
                boxRow(key, { _id: "box_unknown" }),
            ],
            hostdReleases: [
                { _id: "r1", channel: null, createdAt: 1, releaseId: "a", versions: { caddy: "v2", celld: "v0.6.0", hostd: "1.0.0" } },
                { _id: "r2", channel: "stable", createdAt: 2, releaseId: "b", versions: { caddy: "v2", celld: "v0.7.0", hostd: "1.1.0" } },
                { _id: "r3", channel: "canary", createdAt: 3, releaseId: "c", versions: { caddy: "v2", celld: "v0.8.0", hostd: "1.2.0" } },
            ],
            members: [owner("org_1")],
        });

        const boxes = await list.handler(ctx, { organizationId: "org_1" as never });

        expect(Object.fromEntries(boxes.map((box) => [box._id, box.outdated]))).toStrictEqual({ box_new: false, box_old: true, box_unknown: false });
    });
});
