import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop";
import { agentComponent } from "../src/component";
import { defineAgent, defineAgentTool } from "../src/define-agent";
import { DEFAULT_AGENT_FUNCTION_PATHS } from "../src/paths";
import type { AgentFunctionReference, AgentRunFunction } from "../src/types";
import { DurableStepJournal, finalTurn, scriptedGenerate, toolTurn } from "./loop-harness";

interface FakeRow extends Record<string, unknown> {
    _id: string;
}

/** Collect the `.eq(...)` conditions a `withIndex` callback declares. */
const collectConditions = (build: (q: unknown) => unknown): [string, unknown][] => {
    const conditions: [string, unknown][] = [];
    const builder = {
        eq: (field: string, value: unknown) => {
            conditions.push([field, value]);

            return builder;
        },
    };

    build(builder);

    return conditions;
};

const RETRY_MAX_ATTEMPTS = 4;

/**
 * A `step.do` model that RETRIES a callback that throws (Cloudflare Workflows'
 * at-least-once contract) instead of propagating the first failure — so a tool
 * whose `execute` fails once after calling `setState` re-runs against the state
 * that first attempt already committed. `DurableStepJournal` never retries, so
 * it cannot expose the read-modify-write hazard; this double can.
 */
class RetryingStepJournal {
    public readonly invoked: string[] = [];

    private readonly entries = new Map<string, { output: unknown }>();

    public async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const existing = this.entries.get(name);

        if (existing) {
            return existing.output as T;
        }

        this.invoked.push(name);

        let lastError: unknown;

        for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt += 1) {
            try {
                // eslint-disable-next-line no-await-in-loop -- at-least-once retry: attempts are inherently sequential
                const output = await callback();

                this.entries.set(name, { output });

                return output;
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, class-methods-use-this -- mirrors AgentStepLike.waitForEvent's generic host signature so the mock stays assignable
    public async waitForEvent<T>(_name: string, _options: { timeout?: number | string; type: string }): Promise<{ payload: T; type: string }> {
        return new Promise<{ payload: T; type: string }>(() => {});
    }
}

const makeIndexQuery = (candidates: FakeRow[], build: (q: unknown) => unknown): { collect: () => Promise<FakeRow[]>; first: () => Promise<FakeRow | null> } => {
    const conditions = collectConditions(build);
    const matches = (): FakeRow[] => candidates.filter((row) => conditions.every(([field, value]) => row[field] === value));

    return {
        collect: async () => matches(),
        first: async () => matches()[0] ?? null,
    };
};

/**
 * A `run` that dispatches the loop's `agents:*` refs to the REAL component
 * functions over an in-memory `ctx.db`, under a verified identity — so a loop
 * test exercising `ctx.getState()`/`ctx.setState()` also pins the OWNED-thread
 * dispatch read path (risk #1 in the state-sync design: if owned reads were
 * latently anonymous, `getState` would return empty). The harness `memoryRuntime`
 * ignores `ctx.auth`, so it cannot cover the owner gate — this double must.
 */
const ownedRuntime = (userId: string): { rows: Map<string, FakeRow[]>; run: AgentRunFunction } => {
    const rows = new Map<string, FakeRow[]>();
    let nextId = 0;

    const tableRows = (table: string): FakeRow[] => {
        const existing = rows.get(table);

        if (existing) {
            return existing;
        }

        const created: FakeRow[] = [];

        rows.set(table, created);

        return created;
    };

    const database = {
        insert: async (table: string, document: Record<string, unknown>) => {
            const id = `id-${String(nextId)}`;

            nextId += 1;
            tableRows(table).push({ ...document, _id: id });

            return id;
        },
        patch: async (id: string, patch: Record<string, unknown>) => {
            for (const tableContent of rows.values()) {
                const row = tableContent.find((candidate) => candidate["_id"] === id);

                if (row) {
                    for (const [key, value] of Object.entries(patch)) {
                        if (value === undefined) {
                            Reflect.deleteProperty(row, key);
                        } else {
                            row[key] = value;
                        }
                    }
                }
            }
        },
        query: (table: string) => {
            return {
                withIndex: (_name: string, build: (q: unknown) => unknown) => makeIndexQuery(tableRows(table), build),
            };
        },
    };

    const ctx = { auth: { userId }, db: database };
    const { functions } = agentComponent();
    const handlers = new Map<string, { handler: (context: unknown, args: never) => unknown }>([
        [DEFAULT_AGENT_FUNCTION_PATHS.appendMessage, functions.agentAppendMessage],
        [DEFAULT_AGENT_FUNCTION_PATHS.ensureThread, functions.agentEnsureThread],
        [DEFAULT_AGENT_FUNCTION_PATHS.listMessages, functions.agentMessages],
        [DEFAULT_AGENT_FUNCTION_PATHS.patchThread, functions.agentPatchThread],
        [DEFAULT_AGENT_FUNCTION_PATHS.setState, functions.agentSetState],
        [DEFAULT_AGENT_FUNCTION_PATHS.state, functions.agentState],
    ]);

    const run: AgentRunFunction = async (reference: AgentFunctionReference, args?: Record<string, unknown>) => {
        const entry = handlers.get(reference["__lunoraRef"]);

        if (!entry) {
            throw new Error(`unexpected dispatch: ${reference["__lunoraRef"]}`);
        }

        return entry.handler(ctx, (args ?? {}) as never);
    };

    return { rows, run };
};

describe("agent loop — synced state on an owned thread", () => {
    it("seeds initialState, and a tool's setState lands while getState reads it back", async () => {
        const observed: (Record<string, unknown> | undefined)[] = [];

        const agent = defineAgent({
            initialState: { count: 0 },
            model: "m",
            tools: {
                bump: defineAgentTool({
                    description: "increment the synced state",
                    execute: async (_input, ctx) => {
                        const before = await ctx.getState();

                        observed.push(before);
                        await ctx.setState({ count: ((before?.["count"] as number | undefined) ?? 0) + 1 });

                        return "bumped";
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const { rows, run } = ownedRuntime("user-a");

        const result = await runAgentLoop({
            agent,
            env: {},
            exportName: "support",
            generate: scriptedGenerate([toolTurn("call_1", "bump", {}), finalTurn("done")]),
            instanceId: "wf-1",
            params: { input: "go", owner: "user-a", threadKey: "t-1" },
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run,
            step: new DurableStepJournal(),
        });

        expect(result.stopped).toBe("final");

        // getState read the SEEDED state through the owner-gated query — proving
        // the owned-thread dispatch read path returns the real value (not empty).
        expect(observed).toStrictEqual([{ count: 0 }]);

        // setState landed: the thread row carries the absolute-replaced state.
        expect(rows.get("agent_threads")?.[0]?.["state"]).toStrictEqual({ count: 1 });
    });
});

describe("agent loop — setState replay-safety under a mid-step retry", () => {
    it("re-applies a replay-stable (input-derived) setState value exactly once across a retry", async () => {
        // The SAFE pattern: the written value is derived purely from the
        // replay-stable tool input, so re-applying it on a step retry is a no-op
        // and the absolute set converges to the same state.
        let attempts = 0;

        const agent = defineAgent({
            initialState: { count: 0 },
            model: "m",
            tools: {
                set: defineAgentTool({
                    description: "set the counter from the replay-stable input",
                    execute: async (input: { value: number }, ctx) => {
                        await ctx.setState({ count: input.value });
                        attempts += 1;

                        // Fail once AFTER setState committed, forcing a retry.
                        if (attempts === 1) {
                            throw new Error("transient mid-step failure");
                        }

                        return "set";
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const { rows, run } = ownedRuntime("user-a");

        const result = await runAgentLoop({
            agent,
            env: {},
            exportName: "support",
            generate: scriptedGenerate([toolTurn("call_1", "set", { value: 5 }), finalTurn("done")]),
            instanceId: "wf-1",
            params: { input: "go", owner: "user-a", threadKey: "t-1" },
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run,
            step: new RetryingStepJournal(),
        });

        expect(result.stopped).toBe("final");
        expect(attempts).toBe(2); // the step retried once
        // Replay-stable value ⇒ same result after 1 or 2 attempts (idempotent).
        expect(rows.get("agent_threads")?.[0]?.["state"]).toStrictEqual({ count: 5 });
    });

    it("a naive getState-derived read-modify-write double-advances across a retry (the hazard)", async () => {
        // Documents WHY setState values must be replay-stable: getState() reflects
        // the prior attempt's already-committed write, so a naive read-modify-write
        // increments twice when the step is retried at-least-once.
        let attempts = 0;

        const agent = defineAgent({
            initialState: { count: 0 },
            model: "m",
            tools: {
                bump: defineAgentTool({
                    description: "increment via an UNSAFE read-modify-write",
                    execute: async (_input, ctx) => {
                        const before = await ctx.getState();

                        await ctx.setState({ count: ((before?.["count"] as number | undefined) ?? 0) + 1 });
                        attempts += 1;

                        if (attempts === 1) {
                            throw new Error("transient mid-step failure");
                        }

                        return "bumped";
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const { rows, run } = ownedRuntime("user-a");

        await runAgentLoop({
            agent,
            env: {},
            exportName: "support",
            generate: scriptedGenerate([toolTurn("call_1", "bump", {}), finalTurn("done")]),
            instanceId: "wf-1",
            params: { input: "go", owner: "user-a", threadKey: "t-1" },
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run,
            step: new RetryingStepJournal(),
        });

        // count went 0 → 1 (attempt 1) → 2 (retry re-read the written 1): the bug.
        expect(rows.get("agent_threads")?.[0]?.["state"]).toStrictEqual({ count: 2 });
    });

    it("an idempotencyKey-deduped read-modify-write advances exactly once across a retry (the fix)", async () => {
        // The recommended fix for a read-modify-write: record the durable step's
        // idempotencyKey in the state and skip the write when it is already
        // present, so a retry that re-reads the written state is a no-op.
        let attempts = 0;

        const agent = defineAgent({
            initialState: { applied: [], count: 0 },
            model: "m",
            tools: {
                bump: defineAgentTool({
                    description: "increment, deduped on idempotencyKey",
                    execute: async (_input, ctx) => {
                        const before = (await ctx.getState()) ?? { applied: [], count: 0 };
                        const applied = (before["applied"] as string[] | undefined) ?? [];

                        if (!applied.includes(ctx.idempotencyKey)) {
                            await ctx.setState({ applied: [...applied, ctx.idempotencyKey], count: (before["count"] as number) + 1 });
                        }

                        attempts += 1;

                        if (attempts === 1) {
                            throw new Error("transient mid-step failure");
                        }

                        return "bumped";
                    },
                    inputSchema: { jsonSchema: { type: "object" } } as never,
                }),
            },
        });

        const { rows, run } = ownedRuntime("user-a");

        await runAgentLoop({
            agent,
            env: {},
            exportName: "support",
            generate: scriptedGenerate([toolTurn("call_1", "bump", {}), finalTurn("done")]),
            instanceId: "wf-1",
            params: { input: "go", owner: "user-a", threadKey: "t-1" },
            paths: DEFAULT_AGENT_FUNCTION_PATHS,
            run,
            step: new RetryingStepJournal(),
        });

        // Advanced exactly once despite the retry — the dedupe skipped the re-run.
        expect(rows.get("agent_threads")?.[0]?.["state"]).toStrictEqual({ applied: ["tool:bump:call_1"], count: 1 });
    });
});
