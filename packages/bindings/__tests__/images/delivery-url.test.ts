import { describe, expect, it } from "vitest";

import { buildImageDeliveryUrl } from "../../src/images/delivery-url";

describe("buildImageDeliveryUrl", () => {
    it("serializes the new scale-up fit + AI upscale scalars into the option string", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({
            baseUrl: "https://cdn.acme.test",
            key: "uploads/avatar.png",
            transform: { width: 256, fit: "scale-up", upscale: "generate" },
        });

        expect(url).toBe("https://cdn.acme.test/cdn-cgi/image/width=256,fit=scale-up,upscale=generate/uploads/avatar.png");
    });

    it("serializes the new aspect-crop fit mode", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: "https://cdn.acme.test", key: "a.png", transform: { fit: "aspect-crop", height: 100, width: 200 } });

        expect(url).toContain("fit=aspect-crop");
    });

    it("percent-encodes special characters in a relative key segment-by-segment", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: "https://cdn.acme.test", key: "uploads/my photo (1).png", transform: { width: 64 } });

        expect(url).toBe("https://cdn.acme.test/cdn-cgi/image/width=64/uploads/my%20photo%20(1).png");
    });

    it("strips a trailing slash on baseUrl and a leading slash on a relative key", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: "https://cdn.acme.test/", key: "/uploads/a.png" });

        expect(url).toBe("https://cdn.acme.test/cdn-cgi/image/uploads/a.png");
    });

    it("ignores key/transform when imageId is set", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({ baseUrl: "https://cdn.acme.test", imageId: "abc-123", key: "ignored.png", transform: { width: 999 } });

        expect(url).toBe("https://cdn.acme.test/abc-123/public");
    });

    it("drops non-scalar transform values (object-valued gravity) from the option string", () => {
        expect.assertions(2);

        const url = buildImageDeliveryUrl({
            baseUrl: "https://cdn.acme.test",
            key: "a.png",
            transform: { gravity: { mode: "box-center", x: 0.5, y: 0.5 }, width: 128 },
        });

        expect(url).not.toContain("gravity");
        expect(url).toBe("https://cdn.acme.test/cdn-cgi/image/width=128/a.png");
    });

    it("throws a clear error when an option value contains a comma (e.g. rgb() color)", () => {
        expect.assertions(2);

        const build = () =>
            buildImageDeliveryUrl({
                baseUrl: "https://cdn.acme.test",
                key: "a.png",
                transform: { background: "rgb(1,2,3)", width: 128 },
            });

        expect(build).toThrow("@lunora/bindings/images:");
        expect(build).toThrow(/background/);
    });

    it("throws a clear error when an option value contains an equals sign", () => {
        expect.assertions(1);

        expect(() =>
            buildImageDeliveryUrl({
                baseUrl: "https://cdn.acme.test",
                key: "a.png",
                transform: { background: "a=b" },
            }),
        ).toThrow("@lunora/bindings/images:");
    });

    it("rejects a raw `#` hex color (it would start the URL fragment and swallow the source path)", () => {
        expect.assertions(2);

        const build = () =>
            buildImageDeliveryUrl({
                baseUrl: "https://cdn.acme.test",
                key: "a.png",
                transform: { background: "#ff0000", width: 128 },
            });

        // The raw `#` form the old error text endorsed silently truncated the
        // URL; it must now fail loud and steer the caller to `%23RRGGBB`.
        expect(build).toThrow("@lunora/bindings/images:");
        expect(build).toThrow(/%23RRGGBB/);
    });

    it("accepts a percent-encoded hex background color and builds the option string", () => {
        expect.assertions(1);

        const url = buildImageDeliveryUrl({
            baseUrl: "https://cdn.acme.test",
            key: "a.png",
            transform: { background: "%23ff0000", width: 128 },
        });

        expect(url).toBe("https://cdn.acme.test/cdn-cgi/image/background=%23ff0000,width=128/a.png");
    });

    it("rejects a `?` in an option value (it would start the URL query string)", () => {
        expect.assertions(1);

        expect(() => buildImageDeliveryUrl({ baseUrl: "https://cdn.acme.test", key: "a.png", transform: { background: "a?b" } })).toThrow(
            "@lunora/bindings/images:",
        );
    });

    it("rejects a `/` in an option value (it would split the options segment)", () => {
        expect.assertions(1);

        expect(() => buildImageDeliveryUrl({ baseUrl: "https://cdn.acme.test", key: "a.png", transform: { background: "a/b" } })).toThrow(
            "@lunora/bindings/images:",
        );
    });
});
