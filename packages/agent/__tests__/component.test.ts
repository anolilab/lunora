import { describe, expect, it } from "vitest";

import { agentComponent, agentExtension } from "../src/component";

const UNKNOWN_THREAD_PATTERN = /unknown thread/u;

interface FakeRow extends Record<string, unknown> {
    _id: string;
}

/**
 * Minimal `ctx.db` double covering exactly what the component functions use:
 * `query(t).withIndex(name, (q) => q.eq(...).eq(...)).first()/.collect()`,
 * `insert`, `patch`.
 */
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

const makeIndexQuery = (candidates: FakeRow[], build: (q: unknown) => unknown): { collect: () => Promise<FakeRow[]>; first: () => Promise<FakeRow | null> } => {
    const conditions = collectConditions(build);
    const matches = (): FakeRow[] => candidates.filter((row) => conditions.every(([field, value]) => row[field] === value));

    return {
        collect: async () => matches(),
        first: async () => matches()[0] ?? null,
    };
};

const fakeDatabase = (): { ctx: { db: unknown }; rows: Map<string, FakeRow[]> } => {
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
                            delete row[key];
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

    return { ctx: { db: database }, rows };
};

const callMutation = async <R>(
    fn: { handler: (context: unknown, args: never) => Promise<R> | R },
    context: unknown,
    args: Record<string, unknown>,
): Promise<R> => fn.handler(context, args as never);

describe(agentComponent, () => {
    it("ships the auto-prefixed thread tables as a schema extension", () => {
        expect(agentExtension.key).toBe("agent");
        expect(Object.keys(agentExtension.tables).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["messages", "threads"]);
    });

    it("marks the mutations internal and the queries public", () => {
        const { functions } = agentComponent();

        expect(functions.agentAppendMessage.visibility).toBe("internal");
        expect(functions.agentEnsureThread.visibility).toBe("internal");
        expect(functions.agentPatchThread.visibility).toBe("internal");
        expect(functions.agentMessages.visibility).toBeUndefined();
        expect(functions.agentThread.visibility).toBeUndefined();
    });

    it("get-or-creates threads and dedupes appends by messageKey", async () => {
        const { functions } = agentComponent();
        const { ctx } = fakeDatabase();

        const first = await callMutation(functions.agentEnsureThread, ctx, { agent: "support", key: "t-1", title: "Hello" });
        const second = await callMutation(functions.agentEnsureThread, ctx, { agent: "support", key: "t-1" });

        expect(first).toStrictEqual({ created: true });
        expect(second).toStrictEqual({ created: false });

        const appended = await callMutation(functions.agentAppendMessage, ctx, { content: "hi", messageKey: "wf-1:user", role: "user", threadKey: "t-1" });
        const replayed = await callMutation(functions.agentAppendMessage, ctx, { content: "hi", messageKey: "wf-1:user", role: "user", threadKey: "t-1" });
        const next = await callMutation(functions.agentAppendMessage, ctx, {
            content: "yo",
            messageKey: "wf-1:assistant:0",
            role: "assistant",
            threadKey: "t-1",
        });

        expect(appended).toStrictEqual({ seq: 0 });
        expect(replayed).toStrictEqual({ seq: 0 });
        expect(next).toStrictEqual({ seq: 1 });

        const messages = (await callMutation(functions.agentMessages, ctx, { key: "t-1" })) as Record<string, unknown>[];

        expect(messages.map((message) => [message["seq"], message["content"]])).toStrictEqual([
            [0, "hi"],
            [1, "yo"],
        ]);
    });

    it("rejects appends to unknown threads", async () => {
        const { functions } = agentComponent();
        const { ctx } = fakeDatabase();

        await expect(callMutation(functions.agentAppendMessage, ctx, { content: "x", messageKey: "k", role: "user", threadKey: "ghost" })).rejects.toThrow(
            UNKNOWN_THREAD_PATTERN,
        );
    });

    it("patches thread status and returns the newest tail under a limit", async () => {
        const { functions } = agentComponent();
        const { ctx } = fakeDatabase();

        await callMutation(functions.agentEnsureThread, ctx, { agent: "support", key: "t-1" });

        for (let index = 0; index < 4; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seq allocation is the point
            await callMutation(functions.agentAppendMessage, ctx, {
                content: `m${String(index)}`,
                messageKey: `k${String(index)}`,
                role: "user",
                threadKey: "t-1",
            });
        }

        const tail = (await callMutation(functions.agentMessages, ctx, { key: "t-1", limit: 2 })) as Record<string, unknown>[];

        expect(tail.map((message) => message["content"])).toStrictEqual(["m2", "m3"]);

        await callMutation(functions.agentPatchThread, ctx, { error: "boom", key: "t-1", status: "error" });

        const thread = (await callMutation(functions.agentThread, ctx, { key: "t-1" })) as Record<string, unknown>;

        expect(thread["status"]).toBe("error");
        expect(thread["error"]).toBe("boom");
    });
});
