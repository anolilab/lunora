import { describe, expect, it } from "vitest";

import { agentHarness, extractLink, finalTurn, listCapturedMail, toolCallTurn, waitForMail } from "../src/index";

describe("@lunora/testing exports", () => {
    it("re-exports the mail-catcher testing helpers", () => {
        expect.assertions(3);

        expect(typeof extractLink).toBe("function");
        expect(typeof listCapturedMail).toBe("function");
        expect(typeof waitForMail).toBe("function");
    });

    it("re-exports the agent harness helpers", () => {
        expect.assertions(3);

        expect(typeof agentHarness).toBe("function");
        expect(typeof finalTurn).toBe("function");
        expect(typeof toolCallTurn).toBe("function");
    });
});
