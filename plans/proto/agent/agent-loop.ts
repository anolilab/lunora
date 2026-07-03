/**
 * Spike 113 proof-of-concept — a durable, replay-safe single-tool agent loop.
 *
 * Models the machinery Lunora already ships, so the loop is a *composition*, not a
 * new engine:
 *   - LLM turn  -> a named durable step  (real: `ctx.runStep(defineStep("llm:turn-N", ...))`
 *                  -> `step.do("llm:turn-N", cb)`; packages/workflow/src/run-step.ts:130)
 *   - tool call -> a named durable step  (real: `ctx.runStep(defineStep("tool:<name>:<callId>", ...))`)
 *   - message persist -> a DO SQLite write, idempotent by a deterministic message id
 *                  (real: `ctx.db` + the shipped ctx-db idempotency machinery)
 *
 * The replay-safety guarantee comes entirely from the native step memoization that
 * Cloudflare Workflows provides and `run-step.ts` delegates to: `step.do(name, cb)`
 * returns the persisted output of an ALREADY-COMPLETED step WITHOUT re-invoking `cb`.
 * `DurableStepJournal` below is a faithful in-memory model of exactly that contract,
 * so the PoC can assert "a completed tool step does not re-run on resume" without
 * booting Cloudflare Workflows.
 *
 * IMPORTANT nuance the design doc expands on: memoization makes a COMPLETED step
 * replay-safe. A step that FAILS mid-body is retried at-least-once, so a
 * side-effecting tool (charge a card) must still be internally idempotent — the
 * deterministic step name doubles as the idempotency key handed to the tool.
 */

/** A completed step's recorded output (mirrors Cloudflare Workflows' step journal). */
interface JournalEntry {
    output: unknown;
}

/**
 * Faithful model of Cloudflare Workflows' `step.do(name, cb)` memoization:
 * a step name that already has a recorded output returns it WITHOUT calling `cb`.
 * Persisted across a resume by reusing the same journal instance.
 */
export class DurableStepJournal {
    private readonly entries = new Map<string, JournalEntry>();

    /** Names whose `cb` was actually invoked this process (for test assertions). */
    public readonly invoked: string[] = [];

    public async do<T>(name: string, callback: () => Promise<T> | T): Promise<T> {
        const existing = this.entries.get(name);

        if (existing) {
            // Completed on a prior attempt/replay: return cached output, DO NOT re-run.
            return existing.output as T;
        }

        this.invoked.push(name);

        const output = await callback();

        this.entries.set(name, { output });

        return output;
    }

    public has(name: string): boolean {
        return this.entries.has(name);
    }
}

export type Role = "assistant" | "tool" | "user";

export interface ThreadMessage {
    /** Deterministic id -> idempotent across replays. */
    id: string;
    /** ISO timestamp (produced inside a step in the real design so replays are stable). */
    createdAt: string;
    content: string;
    role: Role;
    /** Present on an assistant message that requested a tool. */
    toolCall?: { args: unknown; id: string; name: string };
    /** Present on a tool message (correlates to the assistant `toolCall.id`). */
    toolCallId?: string;
    /** Monotonic per-thread sequence, assigned at persist time. */
    seq: number;
}

/**
 * Idempotent, ordered message store — models a DO SQLite thread table. Upsert by
 * `id` so a replay that re-persists the same message does not duplicate it, and a
 * monotonic `seq` gives a stable thread ordering.
 */
export class MessageStore {
    private readonly byId = new Map<string, ThreadMessage>();

    private nextSeq = 0;

    public upsert(message: Omit<ThreadMessage, "seq"> & { seq?: number }): ThreadMessage {
        const existing = this.byId.get(message.id);

        if (existing) {
            return existing;
        }

        const stored: ThreadMessage = { ...message, seq: this.nextSeq };

        this.nextSeq += 1;
        this.byId.set(message.id, stored);

        return stored;
    }

    public list(): ThreadMessage[] {
        return [...this.byId.values()].sort((a, b) => a.seq - b.seq);
    }
}

/** What the (mocked) LLM returns for a turn: either a tool call or a final answer. */
export type LlmTurn = { kind: "final"; text: string } | { args: unknown; id: string; kind: "tool_call"; name: string; text: string };

export interface AgentDeps {
    /** The durable-step journal (native `step.do` model). Reuse across a resume. */
    journal: DurableStepJournal;
    /** Mock LLM: given the running history, return this turn's action. */
    llm: (history: ReadonlyArray<ThreadMessage>) => Promise<LlmTurn> | LlmTurn;
    /** The message thread store (idempotent, ordered). */
    messages: MessageStore;
    /** Deterministic clock — a step body owns real time in the real design; injected here for stable tests. */
    now: () => string;
    /** Max LLM turns before bailing (cost/step cap — an open question in the design). */
    maxTurns?: number;
    /** Single tool for the PoC. Its step name (`tool:<name>:<callId>`) is its idempotency key. */
    tool: { handler: (args: unknown) => Promise<string> | string; name: string };
    /** Test hook: simulate a mid-loop crash at a labelled checkpoint. */
    checkpoint?: (label: string) => void;
    threadId: string;
    userInput: string;
}

/**
 * Run the durable single-tool agent loop. Each LLM turn and the tool call are
 * named durable steps; message writes are idempotent. Safe to re-invoke with the
 * same `journal` + `messages` after a crash — completed steps are not re-run.
 */
export const runAgent = async (deps: AgentDeps): Promise<ThreadMessage[]> => {
    const maxTurns = deps.maxTurns ?? 8;

    // Persist the user message once (idempotent by deterministic id).
    deps.messages.upsert({ content: deps.userInput, createdAt: deps.now(), id: `${deps.threadId}:user:0`, role: "user" });

    for (let turn = 0; turn < maxTurns; turn += 1) {
        const history = deps.messages.list();

        // LLM turn as a durable step: memoized by name, so a resume returns the
        // recorded decision instead of paying for the model again.
        const decision = await deps.journal.do<LlmTurn>(`llm:turn:${String(turn)}`, () => deps.llm(history));

        if (decision.kind === "final") {
            deps.messages.upsert({
                content: decision.text,
                createdAt: deps.now(),
                id: `${deps.threadId}:assistant:${String(turn)}`,
                role: "assistant",
            });

            return deps.messages.list();
        }

        // Persist the assistant's tool-call intent (idempotent).
        deps.messages.upsert({
            content: decision.text,
            createdAt: deps.now(),
            id: `${deps.threadId}:assistant:${String(turn)}`,
            role: "assistant",
            toolCall: { args: decision.args, id: decision.id, name: decision.name },
        });

        // Tool call as a durable step. The step name IS the idempotency key: on a
        // resume the completed tool returns its recorded result and NEVER re-runs
        // (no double-charge). `decision.id` is the provider's stable tool-call id.
        const stepName = `tool:${decision.name}:${decision.id}`;
        const toolResult = await deps.journal.do<string>(stepName, () => deps.tool.handler(decision.args));

        deps.messages.upsert({
            content: toolResult,
            createdAt: deps.now(),
            id: `${deps.threadId}:tool:${decision.id}`,
            role: "tool",
            toolCallId: decision.id,
        });

        // Injected crash point (test-only): a failure AFTER the tool step committed
        // but BEFORE the next LLM turn. On resume the loop replays from the top and
        // the tool step is served from the journal.
        deps.checkpoint?.(`after-tool:${decision.id}`);
    }

    return deps.messages.list();
};
