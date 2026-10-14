import { describe, expect, it } from "vitest";

import { createStableIdFactory } from "../src/stable-id";

// The shape the runtime's client-id check accepts (`ctx-db.ts` CLIENT_ID_PATTERN).
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

describe("createStableIdFactory", () => {
    it("issues UUIDs the runtime accepts as client ids", () => {
        expect.assertions(1);

        const next = createStableIdFactory("key-1", "user-a");
        const ids = Array.from({ length: 50 }, () => next());

        expect(ids.every((id) => CLIENT_ID.test(id))).toBe(true);
    });

    it("reproduces the same ids for a replay of the same call", () => {
        expect.assertions(1);

        const first = createStableIdFactory("key-1", "user-a");
        const replay = createStableIdFactory("key-1", "user-a");

        expect([first(), first()]).toStrictEqual([replay(), replay()]);
    });

    it("gives distinct ids within one run", () => {
        expect.assertions(1);

        const next = createStableIdFactory("key-1", "user-a");
        const ids = new Set(Array.from({ length: 200 }, () => next()));

        expect(ids.size).toBe(200);
    });

    it("separates calls by key, by caller and by position", () => {
        expect.assertions(3);

        const byKey = createStableIdFactory("key-2", "user-a")();
        const byCaller = createStableIdFactory("key-1", "user-b")();
        const position = createStableIdFactory("key-1", "user-a");

        expect(byKey).not.toBe(createStableIdFactory("key-1", "user-a")());
        expect(byCaller).not.toBe(createStableIdFactory("key-1", "user-a")());
        expect(position()).not.toBe(position());
    });

    it("falls back to a random id without a replay key", () => {
        expect.assertions(2);

        const next = createStableIdFactory(undefined, "user-a");

        expect(CLIENT_ID.test(next())).toBe(true);
        expect(next()).not.toBe(next());
    });
});
