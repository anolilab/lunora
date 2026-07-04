import { describe, expect, it } from "vitest";

import { emitFunctions } from "../src/emit";
import type { AgentIR, FunctionIR } from "../src/ir";

const SUPPORT_AGENT: AgentIR = {
    bindingName: "AGENT_SUPPORT",
    className: "SupportAgentWorkflow",
    exportName: "support",
    name: "agent-support",
};

/** A discovered `lunora/sandbox.ts` exporting `invoke` — collides with the reserved dispatcher path. */
const SANDBOX_INVOKE_FN: FunctionIR = { args: {}, exportName: "invoke", filePath: "sandbox", kind: "query", returnType: "unknown" };

describe("emitFunctions — sandbox gating", () => {
    it("omits the sandbox dispatcher entirely when no sandbox tool is used", () => {
        expect.assertions(3);

        const rendered = emitFunctions({ functions: [] });

        expect(rendered).not.toContain("sandbox:invoke");
        expect(rendered).not.toContain("sandboxComponent");
        expect(rendered).not.toContain("lunoraSandbox");
    });

    it("emits sandbox-free output byte-identical to before the sandbox emitter", () => {
        expect.assertions(1);

        // Fully gated on `usesSandbox`: passing `false` (or omitting it) must yield
        // the exact same bytes as a sandbox-unaware call.
        expect(emitFunctions({ functions: [], usesSandbox: false })).toBe(emitFunctions({ functions: [] }));
    });

    it("registers the internal sandbox action when a sandbox tool is used", () => {
        expect.assertions(3);

        const rendered = emitFunctions({ functions: [], usesSandbox: true });

        expect(rendered).toContain('import { sandboxComponent } from "@lunora/agent/component";');
        expect(rendered).toContain("const lunoraSandbox = sandboxComponent();");
        expect(rendered).toContain('"sandbox:invoke": lunoraSandbox.invoke as unknown as RegisteredLunoraFunction,');
    });

    it("registers both the agent runtime and the sandbox dispatcher when both are present", () => {
        expect.assertions(4);

        const rendered = emitFunctions({ agents: [SUPPORT_AGENT], functions: [], usesSandbox: true });

        expect(rendered).toContain('import { agentComponent } from "@lunora/agent/component";');
        expect(rendered).toContain('import { sandboxComponent } from "@lunora/agent/component";');
        expect(rendered).toContain('"agents:agentMessages": lunoraAgentRuntimeFunctions.agentMessages as unknown as RegisteredLunoraFunction,');
        expect(rendered).toContain('"sandbox:invoke": lunoraSandbox.invoke as unknown as RegisteredLunoraFunction,');
    });

    it("rejects a discovered `sandbox:invoke` that would collide with the auto dispatcher", () => {
        expect.assertions(1);

        // `sandbox:invoke` is reserved when a sandbox tool is imported — a user
        // `lunora/sandbox.ts` exporting `invoke` must error, not be silently
        // shadowed (last-key-wins) by the internal auto entry.
        expect(() => emitFunctions({ functions: [SANDBOX_INVOKE_FN], usesSandbox: true })).toThrow(/"sandbox:invoke" is reserved/u);
    });

    it("leaves a `sandbox:invoke` function untouched when no sandbox tool is used", () => {
        expect.assertions(2);

        // No sandbox tool imported → the path is not reserved and the app's own
        // `sandbox:invoke` is emitted normally (no conflict, no auto entry).
        const rendered = emitFunctions({ functions: [SANDBOX_INVOKE_FN], usesSandbox: false });

        expect(rendered).toContain('"sandbox:invoke"');
        expect(rendered).not.toContain("lunoraSandbox");
    });
});
