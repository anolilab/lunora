import { describe, expect, it } from "vitest";

import { buildImageDeliveryUrl } from "../delivery-url";

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

    it("drops draw overlays — the /cdn-cgi/image URL form can't express them (Workers-only)", () => {
        expect.assertions(2);

        const url = buildImageDeliveryUrl({
            baseUrl: "https://cdn.acme.test",
            key: "a.png",
            transform: { draw: [{ opacity: 0.5, url: "https://cdn.test/logo.png" }], width: 256 },
        });

        expect(url).not.toContain("draw");
        expect(url).toBe("https://cdn.acme.test/cdn-cgi/image/width=256/a.png");
    });
});
