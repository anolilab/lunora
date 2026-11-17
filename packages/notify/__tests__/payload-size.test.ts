import { isLunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { assertPushPayloadFits, PUSH_PAYLOAD_LIMIT_BYTES } from "../src/payload-size";

describe("assertPushPayloadFits", () => {
    it("accepts a payload under the 4096-byte limit", () => {
        expect.hasAssertions();

        expect(() => {
            assertPushPayloadFits({ body: "hi", data: { id: "1" }, title: "t" });
        }).not.toThrow();
    });

    it("rejects an oversize payload with PAYLOAD_TOO_LARGE before any send", () => {
        expect.hasAssertions();

        let caught: unknown;

        try {
            assertPushPayloadFits({ body: "x".repeat(PUSH_PAYLOAD_LIMIT_BYTES) });
        } catch (error) {
            caught = error;
        }

        expect(isLunoraError(caught)).toBe(true);
        expect((caught as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("counts non-string data values as their JSON encoding", () => {
        expect.hasAssertions();

        // Each object encodes to ~12 bytes, so 1000 of them is ~12 KB once JSON-encoded.
        const data = {
            items: Array.from({ length: 1000 }, (_, index) => {
                return { id: index };
            }),
        };

        expect(() => {
            assertPushPayloadFits({ body: "", data });
        }).toThrow("push payload is");
    });

    it("counts an FCM-only sound toward the limit for an FCM target, not for Web Push", () => {
        expect.hasAssertions();

        const sound = "s".repeat(PUSH_PAYLOAD_LIMIT_BYTES + 1);

        expect(() => {
            assertPushPayloadFits({ body: "x", sound }, { fcm: true });
        }).toThrow(/bytes/u);
        expect(() => {
            assertPushPayloadFits({ body: "x", sound }, { fcm: false });
        }).not.toThrow();
    });
});
