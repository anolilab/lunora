import { describe, expect, it } from "vitest";

import type { SessionSpan } from "../src/telemetry/session-rollup";
import { foldSessions } from "../src/telemetry/session-rollup";

/** One generation turn with sane defaults, overridable per case. */
const turn = (options: Partial<SessionSpan> = {}): SessionSpan => {
    return {
        completionTokens: 10,
        endedAt: 1_000,
        level: "info",
        model: "@cf/meta/llama",
        promptTokens: 5,
        sessionId: "s1",
        startedAt: 900,
        traceId: "t1",
        ...options,
    };
};

describe(foldSessions, () => {
    it("groups turns by sessionId with turn count, summed tokens, and first/last seen", () => {
        const [session] = foldSessions(
            [
                turn({ completionTokens: 10, endedAt: 1_000, promptTokens: 5, startedAt: 900, traceId: "ta" }),
                turn({ completionTokens: 20, endedAt: 2_000, promptTokens: 7, startedAt: 1_800, traceId: "tb" }),
            ],
            10,
        );

        expect(session).toMatchObject({
            completionTokens: 30,
            errorCount: 0,
            firstSeen: 900,
            lastSeen: 2_000,
            promptTokens: 12,
            sessionId: "s1",
            totalTokens: 42,
            turnCount: 2,
        });
    });

    it("counts errored turns and collects distinct models in first-seen order", () => {
        const [session] = foldSessions(
            [
                turn({ model: "model-a", startedAt: 100 }),
                turn({ level: "error", model: "model-b", startedAt: 200 }),
                turn({ model: "model-a", startedAt: 300 }),
            ],
            10,
        );

        expect(session?.errorCount).toBe(1);
        expect(session?.models).toEqual(["model-a", "model-b"]);
    });

    it("skips turns with no sessionId (fail-open until the framework emits one)", () => {
        expect(foldSessions([turn({ sessionId: undefined }), turn({ sessionId: "" })], 10)).toEqual([]);
    });

    it("orders sessions newest-active first and honors the limit", () => {
        const sessions = foldSessions(
            [turn({ endedAt: 1_000, sessionId: "old" }), turn({ endedAt: 5_000, sessionId: "new" }), turn({ endedAt: 3_000, sessionId: "mid" })],
            2,
        );

        expect(sessions.map((session) => session.sessionId)).toEqual(["new", "mid"]);
    });

    it("treats missing token counts as zero", () => {
        const [session] = foldSessions([turn({ completionTokens: undefined, promptTokens: undefined })], 10);

        expect(session).toMatchObject({ completionTokens: 0, promptTokens: 0, totalTokens: 0 });
    });
});
