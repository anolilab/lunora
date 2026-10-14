import { describe, expect, it } from "vitest";

import { detectAiAgent } from "../src/agent-env";

describe("agent-env", () => {
    it("returns undefined for a plain human environment", () => {
        expect.assertions(1);

        expect(detectAiAgent({ HOME: "/home/dev", TERM: "xterm-256color" })).toBeUndefined();
    });

    it("detects known agent markers", () => {
        expect.assertions(3);

        expect(detectAiAgent({ CLAUDECODE: "1" })?.name).toBe("Claude Code");
        expect(detectAiAgent({ CURSOR_AGENT: "1" })?.name).toBe("Cursor Agent");
        expect(detectAiAgent({ GEMINI_CLI: "1" })?.name).toBe("Gemini CLI");
    });

    it("ignores empty or explicitly-disabled marker values", () => {
        expect.assertions(2);

        expect(detectAiAgent({ CLAUDECODE: "" })).toBeUndefined();
        expect(detectAiAgent({ CLAUDECODE: "0" })).toBeUndefined();
    });

    it("lUNORA_AGENT_MODE forces the decision both ways", () => {
        expect.assertions(2);

        expect(detectAiAgent({ LUNORA_AGENT_MODE: "1" })?.variable).toBe("LUNORA_AGENT_MODE");
        expect(detectAiAgent({ CLAUDECODE: "1", LUNORA_AGENT_MODE: "0" })).toBeUndefined();
    });

    it("lUNORA_AGENT_MODE disable is case-insensitive", () => {
        expect.assertions(3);

        // A human typing `False`/`FALSE` must not be flipped INTO agent mode.
        expect(detectAiAgent({ CLAUDECODE: "1", LUNORA_AGENT_MODE: "False" })).toBeUndefined();
        expect(detectAiAgent({ CLAUDECODE: "1", LUNORA_AGENT_MODE: "FALSE" })).toBeUndefined();
        expect(detectAiAgent({ CLAUDECODE: "1", LUNORA_AGENT_MODE: " 0 " })).toBeUndefined();
    });
});
