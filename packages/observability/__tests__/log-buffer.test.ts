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
