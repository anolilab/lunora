import { describe, expect, it } from "vitest";

import type { LogEntry } from "../src/log-buffer";
import { LogBuffer } from "../src/log-buffer";

const entry = (message: string, timestamp: number): LogEntry => {
    return { level: "error", message, timestamp };
};

describe("logBuffer", () => {
    it("returns entries newest-first", () => {
        expect.assertions(2);

        const buffer = new LogBuffer();

        for (const event of [entry("first", 1), entry("second", 2), entry("third", 3)]) {
            buffer.push(event);
        }

        expect(buffer.size).toBe(3);
        expect(buffer.entries().map((event) => event.message)).toEqual(["third", "second", "first"]);
    });

    it("evicts the oldest entry once capacity is exceeded", () => {
        expect.assertions(2);

        const buffer = new LogBuffer(2);

        for (const event of [entry("a", 1), entry("b", 2), entry("c", 3)]) {
            buffer.push(event);
        }

        // "a" was dropped to make room; newest-first leaves c, b.
        expect(buffer.size).toBe(2);
        expect(buffer.entries().map((event) => event.message)).toEqual(["c", "b"]);
    });

    it("clear() empties the buffer", () => {
        expect.assertions(2);

        const buffer = new LogBuffer();

        buffer.push(entry("x", 1));
        buffer.clear();

        expect(buffer.size).toBe(0);
        expect(buffer.entries()).toEqual([]);
    });

    it("entries() returns a fresh array the caller can mutate safely", () => {
        expect.assertions(1);

        const buffer = new LogBuffer();

        buffer.push(entry("only", 1));

        const snapshot = buffer.entries();

        snapshot.pop();

        expect(buffer.size).toBe(1);
    });

    it("counts evicted entries so a full ring is distinguishable from a quiet one", () => {
        expect.assertions(4);

        const buffer = new LogBuffer(3);

        for (let index = 0; index < 3; index += 1) {
            buffer.push(entry(`m${String(index)}`, index));
        }

        // Exactly at capacity: nothing dropped yet, so "3 lines" is the truth.
        expect(buffer.dropped).toBe(0);

        for (let index = 3; index < 50; index += 1) {
            buffer.push(entry(`m${String(index)}`, index));
        }

        // Without this count the reader sees 3 entries either way and cannot
        // tell whether 3 lines happened or 50 did.
        expect(buffer.size).toBe(3);
        expect(buffer.dropped).toBe(47);

        buffer.clear();

        expect(buffer.dropped).toBe(0);
    });

    it("falls back to the default capacity for a non-positive bound", () => {
        expect.assertions(1);

        const buffer = new LogBuffer(0);

        for (let index = 0; index < 600; index += 1) {
            buffer.push(entry(`m${String(index)}`, index));
        }

        // Default capacity is 500: the buffer must not grow unbounded.
        expect(buffer.size).toBe(500);
    });
});

describe("logBuffer capacity normalization", () => {
    it("falls back to the default for a capacity that would truncate to zero", () => {
        expect.assertions(2);

        // `> 0` accepted this and `Math.trunc` then made it 0, so the ring
        // evicted every entry it was handed — capture silently off.
        const buffer = new LogBuffer(0.5);

        buffer.push({ level: "info", message: "kept", timestamp: 1 });

        expect(buffer.size).toBe(1);
        expect(buffer.dropped).toBe(0);
    });

    it("falls back to the default for a non-finite capacity", () => {
        expect.assertions(1);

        // Infinity truncates to itself, removing the memory bound the ring
        // exists to impose on a buffer that lives as long as the DO does.
        const buffer = new LogBuffer(Number.POSITIVE_INFINITY);

        for (let index = 0; index < 1200; index += 1) {
            buffer.push({ level: "info", message: String(index), timestamp: index });
        }

        expect(buffer.size).toBeLessThan(1200);
    });
});
