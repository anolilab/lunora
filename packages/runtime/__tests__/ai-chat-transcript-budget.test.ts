import { describe, expect, it } from "vitest";

import { budgetTranscript, MAX_TRANSCRIPT_TURNS } from "../../../shared/ai-chat";

const turn = (index: number): { role: string; text: string } => {
    return { role: index % 2 === 0 ? "user" : "assistant", text: `turn ${index.toString()}` };
};

describe(budgetTranscript, () => {
    it("reads only the newest turns it can keep, however long the transcript", () => {
        expect.assertions(2);

        const transcript: unknown[] = Array.from({ length: 10_000 }, (_, index) => turn(index));

        // An entry older than anything the cap could keep: reading it at all is the waste being bounded.
        Object.defineProperty(transcript, 0, {
            get: () => {
                throw new Error("read an entry the cap discards");
            },
        });

        const { truncated, turns } = budgetTranscript(transcript);

        expect(turns.map((kept) => kept.text)).toStrictEqual(
            Array.from({ length: MAX_TRANSCRIPT_TURNS }, (_, index) => `turn ${(10_000 - MAX_TRANSCRIPT_TURNS + index).toString()}`),
        );
        expect(truncated).toBe(true);
    });

    it("still keeps a full set of valid turns when invalid entries sit among the newest", () => {
        expect.assertions(2);

        const transcript: unknown[] = [...Array.from({ length: 20 }, (_, index) => turn(index)), { role: "system", text: "not a turn" }, 42];
        const { truncated, turns } = budgetTranscript(transcript);

        expect(turns.map((kept) => kept.text)).toStrictEqual(
            Array.from({ length: MAX_TRANSCRIPT_TURNS }, (_, index) => `turn ${(20 - MAX_TRANSCRIPT_TURNS + index).toString()}`),
        );
        expect(truncated).toBe(true);
    });
});
