import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorImageDeliveryUrlAccess } from "../src/image-delivery-url-accesses";
import imagesUrlSourceFromUserInput from "../src/lints/static/images-url-source-from-user-input";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const accesses: AdvisorImageDeliveryUrlAccess[] = [
    { exportName: "avatarUrl", file: "images", line: 4 },
    { exportName: "bannerUrl", file: "images", line: 9 },
];

describe("images_url_source_from_user_input", () => {
    it("flags one WARN finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const findings = imagesUrlSourceFromUserInput.run({ imageDeliveryUrlAccesses: accesses, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "images_url_source_from_user_input:images:4",
            level: "WARN",
            metadata: { exportName: "avatarUrl", file: "images", line: 4 },
            name: "images_url_source_from_user_input",
        });
        expect(findings[0]?.detail).toContain("buildImageDeliveryUrl");
        expect(findings[1]?.cacheKey).toBe("images_url_source_from_user_input:images:9");
    });

    it("finds nothing when the feeder supplies no image-delivery-URL evidence", () => {
        expect.assertions(2);

        expect(imagesUrlSourceFromUserInput.run({ schema: schema() })).toHaveLength(0);
        expect(imagesUrlSourceFromUserInput.run({ imageDeliveryUrlAccesses: [], schema: schema() })).toHaveLength(0);
    });
});
