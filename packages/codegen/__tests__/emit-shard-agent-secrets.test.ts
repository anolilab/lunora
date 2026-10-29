import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";
import type { AgentIR } from "../src/ir";

const support: AgentIR = {
    className: "SupportAgentWorkflow",
    exportName: "support",
    name: "agent-support",
};

const schema = { tables: [], vectorIndexes: [] };

describe("emitShard — agentSecrets", () => {
    it("weaves the secret store onto the ctx beside agents when the target holds secret values", () => {
        expect.assertions(1);

        const emitted = emitShard({ agents: [support], hasSecretValues: true, schema });

        expect(emitted).toContain("agents,\n                agentSecrets: this.secretValues,");
    });

    it("leaves the ctx unchanged for an agent app that does not use requestSecretTool", () => {
        expect.assertions(2);

        const emitted = emitShard({ agents: [support], schema });

        expect(emitted).toContain("const agents = createAgentContext(");
        expect(emitted).not.toContain("agentSecrets");
    });

    it("wires nothing for a target that cannot hold secret values, even with agents declared", () => {
        expect.assertions(1);

        const emitted = emitShard({ agents: [support], hasSecretValues: false, schema });

        expect(emitted).not.toContain("agentSecrets");
    });

    it("wires nothing without agents, since there is no ctx literal to extend", () => {
        expect.assertions(1);

        const emitted = emitShard({ hasSecretValues: true, schema });

        expect(emitted).not.toContain("agentSecrets");
    });
});
