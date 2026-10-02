import { describe, expect, it } from "vitest";

import type { CapabilityKey } from "../src/capabilities";
import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; tests flip one flag at a time. */
const baseOptions = {
    capabilities: new Set<CapabilityKey>(),
    hasAccess: false,
    hasAuth: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdriveGlobal: false,
    hasKvIntrospector: false,
    hasNotify: false,
    hasQueue: false,
    hasScheduler: false,
    hasSourcedTables: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    tables: [],
    useUmbrella: false,
    wantsArchitecture: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — inbound-email (`onEmail`) route wiring", () => {
    it("wires `composed.email` to `dispatchAgentEmail` with the agent definition + its class name", () => {
        expect.assertions(4);

        const output = emitApp({ ...baseOptions, emailAgents: [{ className: "SupportAgentWorkflow", exportName: "support" }] });

        // Imports: the dispatch factory (add-on, never umbrella-routed) + the agent
        // definitions namespace (so `onEmail` mappers are reachable at runtime).
        expect(output).toContain('import { dispatchAgentEmail } from "@lunora/agent/inbound";');
        expect(output).toContain('import * as lunoraAgentDefinitions from "../agents.js";');
        expect(output).toContain("composed.email = dispatchAgentEmail([");
        expect(output).toContain('{ agent: lunoraAgentDefinitions.support, className: "SupportAgentWorkflow" },');
    });

    it("wires every `onEmail` agent as its own dispatch target", () => {
        expect.assertions(2);

        const output = emitApp({
            ...baseOptions,
            emailAgents: [
                { className: "SupportAgentWorkflow", exportName: "support" },
                { className: "SalesAgentWorkflow", exportName: "sales" },
            ],
        });

        expect(output).toContain('{ agent: lunoraAgentDefinitions.support, className: "SupportAgentWorkflow" },');
        expect(output).toContain('{ agent: lunoraAgentDefinitions.sales, className: "SalesAgentWorkflow" },');
    });

    it("keeps a manual `.onEmail(...)` handler able to override the auto-wired default (agent block precedes it)", () => {
        expect.assertions(1);

        const output = emitApp({ ...baseOptions, emailAgents: [{ className: "SupportAgentWorkflow", exportName: "support" }] });

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
