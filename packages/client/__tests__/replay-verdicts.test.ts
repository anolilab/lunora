import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import { indexReplaySlots, replaySlotVerdict } from "../src/replay";

describe("indexReplaySlots", () => {
    it("keeps the envelope of each answered slot, keyed by its index", () => {
        expect.assertions(2);

        const slots = indexReplaySlots([
            { body: { result: encodeWire("a") }, id: 0 },
            { body: { error: { code: "CONFLICT", message: "taken" } }, id: 2 },
        ]);

        expect(slots.get(0)).toStrictEqual({ result: encodeWire("a") });
        expect(slots.get(2)).toStrictEqual({ error: { code: "CONFLICT", message: "taken" } });
    });

    it("leaves out a slot whose body is not an envelope, so it reads as unanswered", () => {
        expect.assertions(3);

        const slots = indexReplaySlots([{ body: null, id: 0 }, { body: {}, id: 1 }, { id: 2 }]);

        expect(slots.has(0)).toBe(false);
        expect(slots.has(1)).toBe(false);
        expect(slots.has(2)).toBe(false);
    });

    it("ignores an entry whose id is not a number", () => {
        expect.assertions(1);

        const slots = indexReplaySlots([{ body: { result: encodeWire(1) } }]);

        expect(slots.size).toBe(0);
    });
});

describe("replaySlotVerdict", () => {
    it("is unanswered when no envelope arrived for the slot", () => {
        expect.assertions(1);

        expect(replaySlotVerdict(undefined)).toStrictEqual({ kind: "unanswered" });
    });

    it("errors a slot carrying an error envelope, with the server's code", () => {
        expect.assertions(2);

        const verdict = replaySlotVerdict({ error: { code: "CONFLICT", message: "taken" } });

        expect(verdict.kind).toBe("errored");
        expect(verdict).toMatchObject({ error: { code: "CONFLICT", message: "taken" } });
    });
});

describe("replaySlotVerdict decode outcomes", () => {
    it("reports a readable committed result as committed, with its value and commit cursor", () => {
        expect.assertions(1);

        expect(replaySlotVerdict({ commitCursor: 4, result: encodeWire({ total: 42n }) })).toStrictEqual({
            commitCursor: 4,
            kind: "committed",
            value: { total: 42n },
        });
    });

    it("reports a committed result the codec refuses as undecodable, not as a failure to retry", () => {
        expect.assertions(2);

        // The write committed; only its reply is unreadable. It must settle, not retry.
        const verdict = replaySlotVerdict({ commitCursor: 4, result: ["$lunora.wire$", "bigint", "not-a-number"] });

        expect(verdict.kind).toBe("undecodable");
        expect(verdict).toMatchObject({ commitCursor: 4, error: { code: "WIRE_DECODE_FAILED" } });
    });
});
