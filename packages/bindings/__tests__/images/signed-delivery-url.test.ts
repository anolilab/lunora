import { describe, expect, it } from "vitest";

import { buildImageDeliveryUrl } from "../../src/images/delivery-url";
import { buildSignedImageUrl, parseSignedTransform, verifySignedImageUrl } from "../../src/images/signed-delivery-url";
import type { TransformOptions } from "../../src/images/types";

const SECRET = "test-signing-secret";
const BASE = "https://cdn.acme.test";

describe("buildSignedImageUrl / verifySignedImageUrl", () => {
    it("round-trips a valid signed URL", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "uploads/avatar.png", secret: SECRET });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.key).toBe("uploads/avatar.png");
    });

    it("binds the transform into the signature and surfaces it on verify", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({
            baseUrl: BASE,
            key: "uploads/avatar.png",
            secret: SECRET,
            transform: { fit: "cover", height: 256, width: 256 },
        });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.transform).toContain("width=256");
    });

    it("rejects a tampered key as bad_signature", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "uploads/avatar.png", secret: SECRET });
        const tampered = url.replace("avatar.png", "secret.png");
        const result = await verifySignedImageUrl(tampered, SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    it("rejects a tampered transform as bad_signature", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({
            baseUrl: BASE,
            key: "uploads/avatar.png",
            secret: SECRET,
            transform: { width: 256 },
        });
        const parsed = new URL(url);

        parsed.searchParams.set("t", "width=4096");

        const result = await verifySignedImageUrl(parsed.toString(), SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    it("rejects an expired URL", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, expiresInSeconds: 1, key: "uploads/avatar.png", secret: SECRET });
        const parsed = new URL(url);

        // Rewind exp to the past, then re-sign-free path: verify must catch expiry
        // before the signature check, so a stale exp is rejected as `expired`.
        parsed.searchParams.set("exp", "1");

        const result = await verifySignedImageUrl(parsed.toString(), SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("expired");
    });

    it("rejects a malformed URL", async () => {
        expect.assertions(2);

        const result = await verifySignedImageUrl("not a url", SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    it("rejects a URL missing the signature as malformed", async () => {
        expect.assertions(2);

        const result = await verifySignedImageUrl(`${BASE}/uploads/avatar.png?exp=99999999999`, SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    it("fails verify under a different secret", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "k.png", secret: SECRET });
        const result = await verifySignedImageUrl(url, "other-secret");

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("bad_signature");
    });

    it("rejects a non-positive TTL at build time", async () => {
        expect.assertions(1);

        await expect(buildSignedImageUrl({ baseUrl: BASE, expiresInSeconds: 0, key: "k.png", secret: SECRET })).rejects.toThrow(/positive finite number/);
    });

    it("rejects a TTL above the 7-day ceiling", async () => {
        expect.assertions(1);

        await expect(buildSignedImageUrl({ baseUrl: BASE, expiresInSeconds: 8 * 24 * 60 * 60, key: "k.png", secret: SECRET })).rejects.toThrow(/7 days/);
    });

    it("verifies under a host-case difference (host is canonicalized lowercase)", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: "https://CDN.Acme.Test", key: "uploads/avatar.png", secret: SECRET });
        // The minted URL carries the original-case host; verify must still pass
        // because both sides lowercase the host before canonicalizing.
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.key).toBe("uploads/avatar.png");
    });

    it("verifies against a rewritten host via expectedHost (CDN/host-rewrite topology)", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "uploads/avatar.png", secret: SECRET });
        // Simulate the Worker seeing a different inbound host than the URL was
        // minted for: rewrite the host, then pass the original as expectedHost.
        const rewritten = url.replace("cdn.acme.test", "worker.internal.test");

        const withoutExpected = await verifySignedImageUrl(rewritten, SECRET);
        const withExpected = await verifySignedImageUrl(rewritten, SECRET, { expectedHost: BASE });

        expect(withoutExpected.valid).toBe(false);
        expect(withExpected.valid).toBe(true);
    });

    it("rejects a non-integer exp as malformed", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "k.png", secret: SECRET });
        const parsed = new URL(url);

        parsed.searchParams.set("exp", "12.5");

        const result = await verifySignedImageUrl(parsed.toString(), SECRET);

        expect(result.valid).toBe(false);
        expect(result.reason).toBe("malformed");
    });

    it("rejects a baseUrl carrying a path — it would make every minted URL fail verification", async () => {
        // The key is verified from the whole url.pathname, so a subpath base
        // (`/img`) would leave verify canonicalizing `img/a.png` while the
        // signature covered `a.png`: 100% bad_signature. Reject it at build time.
        expect.assertions(1);

        await expect(buildSignedImageUrl({ baseUrl: "https://cdn.acme.test/img", key: "a.png", secret: SECRET })).rejects.toThrow(/must not carry a path/);
    });

    it("accepts a baseUrl with a bare trailing-slash root path", async () => {
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: "https://cdn.acme.test/", key: "a.png", secret: SECRET });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.key).toBe("a.png");
    });

    it("accepts a multi-trailing-slash baseUrl and still verifies", async () => {
        expect.assertions(3);

        // A pathname of only slashes (`//`) is not a subpath — the builder
        // collapses it to the bare origin, same as `@lunora/storage`'s
        // `buildSignedUrl`, so the two guards agree on what counts as "no path".
        const url = await buildSignedImageUrl({ baseUrl: "https://cdn.acme.test//", key: "a.png", secret: SECRET });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(new URL(url).pathname).toBe("/a.png");
        expect(result.valid).toBe(true);
        expect(result.key).toBe("a.png");
    });

    it("rejects a key containing a raw newline at sign time (BINDINGS-01)", async () => {
        expect.assertions(1);

        // The canonical is `host\nkey\nexp\ntransform` — `key` is not its last
        // field, so a raw \n in it could shift where `exp` re-splits on verify,
        // letting an attacker-influenced key smuggle a different expiry under
        // the same signature.
        await expect(buildSignedImageUrl({ baseUrl: BASE, key: "uploads/avatar.png\n9999999999\n", secret: SECRET })).rejects.toThrow(/control character/);
    });

    it("rejects a key containing a carriage return at sign time", async () => {
        expect.assertions(1);

        await expect(buildSignedImageUrl({ baseUrl: BASE, key: "uploads/avatar\r.png", secret: SECRET })).rejects.toThrow(/control character/);
    });

    it("round-trips a key that has a leading slash (canonical/URL mismatch regression)", async () => {
        // A leading-slash key was previously signed with the slash in the
        // canonical but built into the URL without it, so verify always returned
        // bad_signature. Both paths now normalize the key first.
        expect.assertions(2);

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "/uploads/avatar.png", secret: SECRET });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.key).toBe("uploads/avatar.png");
    });
});

describe("buildImageDeliveryUrl", () => {
    it("builds the /cdn-cgi/image transform path for a relative key", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, key: "uploads/avatar.png", transform: { width: 256, fit: "cover" } });

        expect(url).toBe(`${BASE}/cdn-cgi/image/width=256,fit=cover/uploads/avatar.png`);
    });

    it("leaves an absolute source URL verbatim after the options", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, key: "https://origin.test/a.png", transform: { width: 100 } });

        expect(url).toBe(`${BASE}/cdn-cgi/image/width=100/https://origin.test/a.png`);
    });

    it("omits the options segment when no transform is given", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, key: "a.png" });

        expect(url).toBe(`${BASE}/cdn-cgi/image/a.png`);
    });

    it("builds the hosted delivery-variant form for an imageId", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, imageId: "abc-123", variant: "thumbnail" });

        expect(url).toBe(`${BASE}/abc-123/thumbnail`);
    });

    it("defaults the variant to public", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: BASE, imageId: "abc-123" });

        expect(url).toBe(`${BASE}/abc-123/public`);
    });

    it("throws when neither imageId nor key is supplied", () => {
        expect.assertions(1);

        expect(() => buildImageDeliveryUrl({ baseUrl: BASE })).toThrow(/requires either/);
    });
});

describe("parseSignedTransform", () => {
    it("round-trips every value kind through the serialized form", async () => {
        expect.assertions(1);

        // One key per kind the encoder emits: numbers, enum strings, a free
        // string, and the gravity string-or-object union taking its object arm.
        // (TransformOptions has no boolean-typed key today; if one is added,
        // extend this fixture with it.)
        const transform: TransformOptions = {
            background: "#00000080",
            fit: "cover",
            gravity: { mode: "box-center", x: 10, y: 20 },
            width: 256,
        };

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "a.png", secret: SECRET, transform });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(parseSignedTransform(result.transform ?? "")).toStrictEqual(transform);
    });

    it("parses the empty string to an empty options object", () => {
        expect.assertions(1);

        expect(parseSignedTransform("")).toStrictEqual({});
    });

    it("splits each segment on the first '=' only, so values containing '=' survive", () => {
        expect.assertions(1);

        expect(parseSignedTransform("background=color=red")).toStrictEqual({ background: "color=red" });
    });

    it("is surfaced by verifySignedImageUrl as transformOptions", async () => {
        expect.assertions(3);

        const url = await buildSignedImageUrl({
            baseUrl: BASE,
            key: "uploads/avatar.png",
            secret: SECRET,
            transform: { fit: "cover", height: 256, width: 256 },
        });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.transformOptions).toStrictEqual({ fit: "cover", height: 256, width: 256 });

        // No transform → no transformOptions (not an empty object).
        const bare = await verifySignedImageUrl(await buildSignedImageUrl({ baseUrl: BASE, key: "a.png", secret: SECRET }), SECRET);

        expect(bare.transformOptions).toBeUndefined();
    });

    it("throws on a key the current TransformOptions does not declare", () => {
        expect.assertions(1);

        expect(() => parseSignedTransform("wdith=256")).toThrow(/unknown transform key "wdith"/);
    });

    it("does not let a transform value splice extra keys under the signature", async () => {
        expect.assertions(3);

        // The signature binds the serialized transform, so whatever the encoder
        // emits is what the verifier authorises. A user-influenced value — a
        // `background` colour, a `gravity` — carrying the separators verbatim
        // therefore mints a URL whose decoded transform is not the one that was
        // signed: here a 10000px render nobody asked for, under a signature that
        // verifies. It is also what keeps a legitimate `&` inside a value from
        // being read as the start of a new entry.
        const transform: TransformOptions = { background: "blue&width=10000&fit=contain", height: 128 };

        const url = await buildSignedImageUrl({ baseUrl: BASE, key: "a.png", secret: SECRET, transform });
        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.transformOptions).toStrictEqual(transform);
        expect(result.transformOptions?.width).toBeUndefined();
    });

    it("leaves transformOptions undefined instead of throwing when a verified transform is unreadable", async () => {
        expect.assertions(3);

        // A signed URL outlives a deploy: an old-but-genuine URL can carry a key
        // this build no longer knows (renamed, or minted by a newer version).
        // The encoder signs whatever keys the object carries, so an extra key
        // reproduces that URL exactly. The request must stay valid, with the raw
        // string still returned, rather than throwing out of the request path.
        const url = await buildSignedImageUrl({
            baseUrl: BASE,
            key: "a.png",
            secret: SECRET,
            transform: { legacyFit: "cover", width: 256 } as unknown as TransformOptions,
        });

        const result = await verifySignedImageUrl(url, SECRET);

        expect(result.valid).toBe(true);
        expect(result.transformOptions).toBeUndefined();
        // eslint-disable-next-line no-secrets/no-secrets -- a deterministic serialized transform, not a credential
        expect(result.transform).toBe("legacyFit=cover&width=256");
    });

    it("throws on an uncoercible value for a number-typed key", () => {
        expect.assertions(1);

        expect(() => parseSignedTransform("width=huge")).toThrow(/expects a number/);
    });
});
