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

describe("emitApp — voice-agent route wiring", () => {
    it("maps each voice agent's export name to its `VOICE_*` namespace read structurally off `env`", () => {
        expect.assertions(2);

        const output = emitApp({ ...baseOptions, voiceAgents: [{ bindingName: "VOICE_SUPPORT", exportName: "support" }] });

        expect(output).toContain("options.voiceAgents = {");
        // Read off `env` structurally — the binding is provisioned by the config
        // reconcile step and may not be on the generated `Env` type.
        expect(output).toContain('"support": (env as Record<string, unknown>)["VOICE_SUPPORT"] as ShardNamespaceLike,');
    });

    it("wires every declared voice agent, keyed by export name", () => {
        expect.assertions(2);

        const output = emitApp({
            ...baseOptions,
            voiceAgents: [
                { bindingName: "VOICE_SUPPORT", exportName: "support" },
                { bindingName: "VOICE_SALES", exportName: "sales" },
            ],
        });

        expect(output).toContain('"support": (env as Record<string, unknown>)["VOICE_SUPPORT"] as ShardNamespaceLike,');
        expect(output).toContain('"sales": (env as Record<string, unknown>)["VOICE_SALES"] as ShardNamespaceLike,');
    });

    it("emits nothing voice-related when no agent opts into voice (absent or empty ⇒ byte-identical)", () => {
        expect.assertions(2);

        expect(emitApp(baseOptions)).not.toContain("options.voiceAgents");
        expect(emitApp({ ...baseOptions, voiceAgents: [] })).not.toContain("options.voiceAgents");
    });
});
