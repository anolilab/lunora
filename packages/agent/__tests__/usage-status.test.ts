import { describe, expect, it } from "vitest";

import { addUsage } from "../src/agent-loop";
import type { AgentUsage } from "../src/types";

type Status = NonNullable<AgentUsage["status"]>;

/** A turn that reported both totals, carrying `status` when the caller sets one. */
const counted = (status?: Status): AgentUsage => {
    return { inputTokens: 2, outputTokens: 1, ...(status === undefined ? {} : { status }) };
};

describe("addUsage grades the run's status from its steps", () => {
    it.each<[Status, Status, Status]>([
        ["complete", "complete", "complete"],
        ["complete", "partial", "partial"],
        ["partial", "complete", "partial"],
        ["complete", "unavailable", "partial"],
        ["partial", "unavailable", "partial"],
        ["partial", "partial", "partial"],
        ["unavailable", "unavailable", "unavailable"],
    ])("%s + %s is %s", (base, next, expected) => {
        expect(addUsage(counted(base), counted(next))).toMatchObject({ inputTokens: 4, outputTokens: 2, status: expected });
    });

    it("takes the first step's status when there is no accumulator yet", () => {
        expect(addUsage(undefined, counted("partial"))).toStrictEqual({ inputTokens: 2, outputTokens: 1, status: "partial" });
        expect(addUsage(undefined, { status: "unavailable" })).toStrictEqual({ status: "unavailable" });
    });

    it("leaves the total as it was when a turn carries no usage at all", () => {
        expect(addUsage(counted("partial"), undefined)).toStrictEqual(counted("partial"));
    });

    it("grades a step that predates the status field from its counts, not as complete", () => {
        // A replayed step written before `status` existed: both totals present, so it grades complete.
        expect(addUsage(undefined, { inputTokens: 2, outputTokens: 1 })).toStrictEqual({ inputTokens: 2, outputTokens: 1, status: "complete" });
        // Only a total the step never reported is absent, so it grades partial when it is merged in.
        expect(addUsage(counted("complete"), { inputTokens: 5 })).toMatchObject({ inputTokens: 7, status: "partial" });
        // A legacy step with no counts grades unavailable, and merging it into a complete total makes the total partial.
        expect(addUsage(counted("complete"), { totalTokens: 9 })).toMatchObject({ status: "partial" });
    });
});
