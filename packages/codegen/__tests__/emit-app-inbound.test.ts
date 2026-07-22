import { describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; tests flip one flag at a time. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — inbound-email (`onEmail`) route wiring", () => {
    it("wires `composed.email` to `dispatchAgentEmail` with the agent definition + its `AGENT_*` binding", () => {
        expect.assertions(4);

        const output = emitApp({ ...baseOptions, emailAgents: [{ bindingName: "AGENT_SUPPORT", exportName: "support" }] });

        // Imports: the dispatch factory (add-on, never umbrella-routed) + the agent
        // definitions namespace (so `onEmail` mappers are reachable at runtime).
        expect(output).toContain('import { dispatchAgentEmail } from "@lunora/agent/inbound";');
        expect(output).toContain('import * as lunoraAgentDefinitions from "../agents.js";');
        expect(output).toContain("composed.email = dispatchAgentEmail([");
        expect(output).toContain('{ agent: lunoraAgentDefinitions.support, binding: "AGENT_SUPPORT" },');
    });

    it("wires every `onEmail` agent as its own dispatch target", () => {
        expect.assertions(2);

        const output = emitApp({
            ...baseOptions,
            emailAgents: [
                { bindingName: "AGENT_SUPPORT", exportName: "support" },
                { bindingName: "AGENT_SALES", exportName: "sales" },
            ],
        });

        expect(output).toContain('{ agent: lunoraAgentDefinitions.support, binding: "AGENT_SUPPORT" },');
        expect(output).toContain('{ agent: lunoraAgentDefinitions.sales, binding: "AGENT_SALES" },');
    });

    it("keeps a manual `.onEmail(...)` handler able to override the auto-wired default (agent block precedes it)", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, emailAgents: [{ bindingName: "AGENT_SUPPORT", exportName: "support" }] });

        // The generated `dispatchAgentEmail` assignment must appear BEFORE the
        // `if (this.emailHandler)` override so a hand-registered handler wins.
        expect(output.indexOf("composed.email = dispatchAgentEmail([")).toBeLessThan(output.indexOf("if (this.emailHandler) {"));
    });

    it("emits nothing email-related when no agent declares `onEmail` (absent or empty ⇒ byte-identical)", () => {
        expect.assertions(4);

        const absent = emitApp(baseOptions);
        const empty = emitApp({ ...baseOptions, emailAgents: [] });

        expect(absent).not.toContain("dispatchAgentEmail");
        expect(absent).not.toContain("lunoraAgentDefinitions");
        // Absent and empty must be identical to each other (the guard treats both the
        // same), and neither adds inbound wiring.
        expect(empty).toStrictEqual(absent);
        expect(empty).not.toContain("dispatchAgentEmail");
    });
});
