import { describe, expect, it } from "vitest";

import { DEFAULT_CDC_LOG_RETENTION_ROWS, resolveCdcLogRetention } from "../src/cdc-retention";

describe("changelog row retention default", () => {
    it("bounds the log when the knob is unset", () => {
        expect.assertions(2);

        expect(resolveCdcLogRetention({})).toBe(DEFAULT_CDC_LOG_RETENTION_ROWS);
        expect(DEFAULT_CDC_LOG_RETENTION_ROWS).toBeGreaterThan(0);
    });

    it("honours an explicit window", () => {
        expect.assertions(2);

        expect(resolveCdcLogRetention({ LUNORA_CDC_LOG_RETENTION: "250" })).toBe(250);
        expect(resolveCdcLogRetention({ LUNORA_CDC_LOG_RETENTION: 250 })).toBe(250);
    });

    it("deletes no rows when only the payload window is configured", () => {
        expect.assertions(3);

        // A payload-only operator asked for compaction; a row window they never set would delete rows it should keep.
        expect(resolveCdcLogRetention({ LUNORA_CDC_PAYLOAD_RETENTION: "5" })).toBeUndefined();
        expect(resolveCdcLogRetention({ LUNORA_CDC_PAYLOAD_RETENTION: "5x" })).toBe(DEFAULT_CDC_LOG_RETENTION_ROWS);
        expect(resolveCdcLogRetention({ LUNORA_CDC_PAYLOAD_RETENTION: "5", LUNORA_CDC_LOG_RETENTION: "250" })).toBe(250);
    });

    it("still bounds the log when the row window is malformed next to a valid payload window", () => {
        expect.assertions(2);

        expect(resolveCdcLogRetention({ LUNORA_CDC_LOG_RETENTION: "10k", LUNORA_CDC_PAYLOAD_RETENTION: "5" })).toBe(DEFAULT_CDC_LOG_RETENTION_ROWS);
        expect(resolveCdcLogRetention({ LUNORA_CDC_LOG_RETENTION: "", LUNORA_CDC_PAYLOAD_RETENTION: "5" })).toBeUndefined();
    });

    it("lets a deployment opt out explicitly with `off`", () => {
        expect.assertions(2);

        expect(resolveCdcLogRetention({ LUNORA_CDC_LOG_RETENTION: "off" })).toBeUndefined();
        expect(resolveCdcLogRetention({ LUNORA_CDC_LOG_RETENTION: " OFF " })).toBeUndefined();
    });

    it("reads a malformed value as the default window, never as a tighter one", () => {
        expect.assertions(2);

        // `Number.parseInt` would read "10k" as 10 and delete the changelog.
        expect(resolveCdcLogRetention({ LUNORA_CDC_LOG_RETENTION: "10k" })).toBe(DEFAULT_CDC_LOG_RETENTION_ROWS);
        expect(resolveCdcLogRetention({ LUNORA_CDC_LOG_RETENTION: "0" })).toBe(DEFAULT_CDC_LOG_RETENTION_ROWS);
    });
});
