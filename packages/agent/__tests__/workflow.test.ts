import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentLoopOptions } from "../src/agent-loop";
import { runAgentLoop } from "../src/agent-loop";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentDefinition, AgentFunctionPaths, AgentRunFunction, AgentRunResult } from "../src/types";
import compileAgentWorkflow from "../src/workflow";

// Stub the loop at the module boundary (the handler imports it directly) so the
// suite characterizes ONLY the compile-time wiring: what the handler hands the
// loop, not what the loop does with it.
vi.mock(import("../src/agent-loop"), async (importOriginal) => {
    const original = await importOriginal();

    return {
        ...original,
        runAgentLoop: vi.fn<() => Promise<AgentRunResult>>(async () => {
            return { stopped: "final", text: "ok", turns: 1 };
        }),
    };
});

/** A construction-pure model factory so `createAgentGenerate` needs no `AI` binding. */
const fakeModel = (): AgentDefinition["model"] => () => ({}) as never;

const minimalAgent = (overrides?: Partial<AgentDefinition>): AgentDefinition => ({ instructions: "help", model: fakeModel(), ...overrides }) as AgentDefinition;

/** A sentinel dispatcher so the ownerless branch can be asserted by reference identity. */
const sentinelRun: AgentRunFunction = async () => "sentinel";

/** The minimal workflow handler context the compiled handler reads. */
const makeContext = (env: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => {
    return {
        env,
        event: { instanceId: "wf-instance-1" },
        params: { input: "hi", threadKey: "t-1", ...params },
        run: sentinelRun,
        step: { do: async <T>(_name: string, callback: () => Promise<T>): Promise<T> => callback() },
    };
};

const OTLP_ENV = { LUNORA_OTLP_ENDPOINT: "https://otlp.example", LUNORA_OTLP_TOKEN: "tok" };

/** Run the compiled handler and return the options the (mocked) loop received. */
const compileAndRun = async (
    agent: AgentDefinition,
    env: Record<string, unknown> = {},
    options?: { params?: Record<string, unknown>; paths?: AgentFunctionPaths },
): Promise<AgentLoopOptions> => {
    const definition = compileAgentWorkflow(agent, "support", options?.paths === undefined ? undefined : { paths: options.paths });

    await definition.handler(makeContext(env, options?.params) as never);

    const call = vi.mocked(runAgentLoop).mock.calls.at(-1)?.[0];

    if (call === undefined) {
        throw new Error("runAgentLoop was not called");
    }

    return call;
};

describe(compileAgentWorkflow, () => {
    beforeEach(() => {
        vi.mocked(runAgentLoop).mockClear();
    });

    it("derives the workflow name from the export name and honors an explicit agent name", () => {
        expect(compileAgentWorkflow(minimalAgent(), "supportBot").name).toBe("agent-support-bot");
        expect(compileAgentWorkflow(minimalAgent({ name: "custom-name" }), "supportBot").name).toBe("custom-name");
    });

    describe("auto OTLP telemetry", () => {
        it("leaves the definition untouched when no LUNORA_OTLP_ENDPOINT is set", async () => {
            const agent = minimalAgent();

            const received = await compileAndRun(agent, {});

            // Same reference — the no-endpoint path is a byte-identical no-op.
            expect(received.agent).toBe(agent);
        });

        it("leaves the definition untouched when the app set telemetry.isEnabled: false", async () => {
            const agent = minimalAgent({ telemetry: { isEnabled: false } });

            const received = await compileAndRun(agent, OTLP_ENV);

            expect(received.agent).toBe(agent);
        });

        it("appends the OTLP integration and enables telemetry when the endpoint is injected", async () => {
            const agent = minimalAgent();

            const received = await compileAndRun(agent, OTLP_ENV);

            expect(received.agent).not.toBe(agent);

            const telemetry = received.agent.telemetry as { integrations: unknown[]; isEnabled: boolean };

            expect(telemetry.isEnabled).toBe(true);
            expect(telemetry.integrations).toHaveLength(1);
        });

        it("normalizes a single prior integration and an array, appending OTLP after the existing ones", async () => {
            const single = { marker: "single" };
            const asSingle = await compileAndRun(minimalAgent({ telemetry: { integrations: single } } as Partial<AgentDefinition>), OTLP_ENV);

            const singleTelemetry = asSingle.agent.telemetry as { integrations: unknown[] };

            expect(singleTelemetry.integrations).toHaveLength(2);
            expect(singleTelemetry.integrations[0]).toBe(single);

            const first = { marker: "first" };
            const second = { marker: "second" };
            const asArray = await compileAndRun(minimalAgent({ telemetry: { integrations: [first, second] } } as Partial<AgentDefinition>), OTLP_ENV);

            const arrayTelemetry = asArray.agent.telemetry as { integrations: unknown[] };

            expect(arrayTelemetry.integrations).toHaveLength(3);
            expect(arrayTelemetry.integrations[0]).toBe(first);
            expect(arrayTelemetry.integrations[1]).toBe(second);
        });
    });

    describe("handler seam wiring", () => {
        it("passes the default function paths when no override is given", async () => {
            const received = await compileAndRun(minimalAgent());

            expect(received.paths).toBe(DEFAULT_AGENT_FUNCTION_PATHS);
        });

        it("passes a paths override through to the loop", async () => {
            const paths = { ...DEFAULT_AGENT_FUNCTION_PATHS, appendMessage: "custom:appendMessage" };

            const received = await compileAndRun(minimalAgent(), {}, { paths });

            expect(received.paths).toBe(paths);
        });

        it("keeps the identity-free context.run for an ownerless run and wraps it for an owned run", async () => {
            const ownerless = await compileAndRun(minimalAgent());

            expect(ownerless.run).toBe(sentinelRun);

            const owned = await compileAndRun(
                minimalAgent(),
                { LUNORA_ADMIN_TOKEN: "admin", LUNORA_ORIGIN_URL: "https://app.example/" },
                { params: { owner: "user-a" } },
            );

            // `resolveAgentRun` must dispatch under the owner's identity — NOT the
            // raw workflow dispatcher — or owner-gated thread reads come back empty.
            expect(owned.run).not.toBe(sentinelRun);
        });

        it("forwards the workflow instance id and step to the loop", async () => {
            const received = await compileAndRun(minimalAgent());

            expect(received.instanceId).toBe("wf-instance-1");
            expect(received.step).toBeDefined();
        });
    });
});
