import { LunoraProvider } from "@lunora/react";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { AssistantValue } from "../../src/components/assistant-provider";
import { AssistantProvider, useAssistant } from "../../src/components/assistant-provider";
import type { AiAvailableResult } from "../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../src/lib/admin";
import { createMockClient } from "../mock-client";

/** The provider over a client that reports an AI binding, so nothing latches unavailable. */
const wrapper = ({ children }: { readonly children: ReactNode }): ReactElement => (
    <LunoraProvider
        client={
            createMockClient({
                query: () => {
                    return { available: true };
                },
            }).asClient
        }
    >
        <AssistantProvider>{children}</AssistantProvider>
    </LunoraProvider>
);

const render = () => renderHook(() => useAssistant() as AssistantValue, { wrapper });

describe("assistantProvider", () => {
    it("gives a seeded question its own session rather than appending to the open one", () => {
        expect.assertions(3);

        // The one behavioural rule the whole seed design rests on: a seeded question
        // arrives with its own context (a specific error, a specific lint), and
        // appending it to whatever was being discussed is how one transcript becomes
        // two conversations interleaved.
        const { result } = render();

        act(() => {
            result.current.openAssistant({ title: "SQL console" });
        });

        const first = result.current.activeId;

        act(() => {
            result.current.openAssistant({ ask: "why did this fail?", title: "Debug error" });
        });

        expect(result.current.activeId).not.toBe(first);
        expect(result.current.sessions).toHaveLength(2);
        expect(result.current.pendingAsk?.sessionId).toBe(result.current.activeId);
    });

    it("reuses the open session when the seed adds no question", () => {
        expect.assertions(2);

        const { result } = render();

        act(() => {
            result.current.openAssistant({ title: "SQL console" });
        });

        const first = result.current.activeId;

        act(() => {
            result.current.openAssistant({ title: "SQL console" });
        });

        expect(result.current.activeId).toBe(first);
        expect(result.current.sessions).toHaveLength(1);
    });

    it("does not reuse a session on another shard for a seed that omits the shard key", () => {
        expect.assertions(3);

        // An omitted key means the root shard, so a seed that names none must not
        // inherit a non-root conversation: its tool reads would hit that shard.
        const { result } = render();

        act(() => {
            result.current.openAssistant({ shardKey: "shard-a", title: "SQL console" });
        });

        const first = result.current.activeId;

        act(() => {
            result.current.openAssistant({ title: "Advisor" });
        });

        expect(result.current.activeId).not.toBe(first);
        expect(result.current.sessions).toHaveLength(2);
        expect(result.current.sessions.at(-1)?.shardKey).toBeUndefined();
    });

    it("moves an empty conversation to the shard the console switched to, dropping its grounding", () => {
        expect.assertions(4);

        // The shard input reports every keystroke. The first switch moves the empty
        // conversation, and the next keystroke moves it again rather than starting another.
        const { result } = render();

        act(() => {
            result.current.openAssistant({ schema: [{ columns: ["id"], table: "messages" }], shardKey: "shard-a", title: "SQL console" });
        });

        act(() => {
            result.current.rebindShard("shard-a", "shard-b");
        });

        expect(result.current.sessions).toHaveLength(1);
        expect(result.current.sessions[0]?.shardKey).toBe("shard-b");
        expect(result.current.sessions[0]?.schema).toStrictEqual([]);

        act(() => {
            result.current.rebindShard("shard-b", "shard-bc");
        });

        expect(result.current.sessions).toHaveLength(1);
    });

    it("starts a new conversation on the new shard when the open one has answers, and keeps the old one", () => {
        expect.assertions(5);

        const { result } = render();

        act(() => {
            result.current.openAssistant({ shardKey: "shard-a", title: "SQL console" });
        });

        const first = result.current.activeId ?? "";

        act(() => {
            result.current.setTurns(first, [{ role: "user", text: "hello" }]);
        });

        act(() => {
            result.current.rebindShard("shard-a", "shard-b");
        });

        // The old conversation keeps its shard and its answers; the new one is on shard-b.
        expect(result.current.sessions).toHaveLength(2);
        expect(result.current.sessions[0]).toMatchObject({ shardKey: "shard-a", turns: [{ role: "user", text: "hello" }] });
        expect(result.current.sessions[1]?.shardKey).toBe("shard-b");
        expect(result.current.activeId).toBe(result.current.sessions[1]?.id);

        // The next keystroke lands on the new, empty conversation and moves it in place.
        act(() => {
            result.current.rebindShard("shard-b", "shard-bc");
        });

        expect(result.current.sessions).toHaveLength(2);
    });

    it("leaves a closed panel and a conversation on another shard where they are", () => {
        expect.assertions(2);

        const { result } = render();

        act(() => {
            result.current.openAssistant({ shardKey: "shard-a", title: "SQL console" });
        });

        act(() => {
            result.current.close();
            result.current.rebindShard("shard-a", "shard-b");
        });

        expect(result.current.sessions[0]?.shardKey).toBe("shard-a");

        act(() => {
            result.current.toggle();
            result.current.rebindShard("shard-z", "shard-c");
        });

        expect(result.current.sessions[0]?.shardKey).toBe("shard-a");
    });

    it("refreshes a reused session's schema from the new seed and keeps its transcript", () => {
        expect.assertions(4);

        // A conversation opened before the schema probe landed holds an empty set;
        // reopening it from the editor must hand the model the facts the editor has
        // now, or every later turn is grounded in a database with no tables.
        const { result } = render();

        act(() => {
            result.current.openAssistant({ schema: [], shardKey: "", title: "SQL console" });
        });

        const first = result.current.activeId ?? "";

        act(() => {
            result.current.setTurns(first, [{ role: "user", text: "hello" }]);
            result.current.openAssistant({ schema: [{ columns: ["id"], table: "messages" }], shardKey: "", title: "SQL console" });
        });

        expect(result.current.activeId).toBe(first);
        expect(result.current.sessions[0]?.schema).toStrictEqual([{ columns: ["id"], table: "messages" }]);
        expect(result.current.sessions[0]?.turns).toHaveLength(1);

        // A seed that carries no schema leaves the grounding alone.
        act(() => {
            result.current.openAssistant({ title: "SQL console" });
        });

        expect(result.current.sessions[0]?.schema).toHaveLength(1);
    });

    it("evicts the oldest session past the cap without stranding the active one", () => {
        expect.assertions(2);

        const { result } = render();

        act(() => {
            for (let index = 0; index < 15; index += 1) {
                result.current.newChat({ ask: `question ${String(index)}` });
            }
        });

        // Eviction drops from the FRONT, and every path that appends also makes the
        // new session active — so `activeId` can never point at an evicted one.
        expect(result.current.sessions.length).toBeLessThanOrEqual(10);
        expect(result.current.sessions.some((session) => session.id === result.current.activeId)).toBe(true);
    });

    it("lands on another conversation when the active one is deleted", () => {
        expect.assertions(2);

        const { result } = render();

        act(() => {
            result.current.newChat({ title: "SQL console" });
            result.current.newChat({ title: "Debug error" });
        });

        const active = result.current.activeId as string;

        act(() => {
            result.current.deleteChat(active);
        });

        // Falling back to the last remaining session rather than to `undefined`:
        // deleting the active one should not leave an empty panel to reopen.
        expect(result.current.activeId).toBeDefined();
        expect(result.current.activeId).not.toBe(active);
    });

    it("clears a pending ask only by its own id", () => {
        expect.assertions(2);

        const { result } = render();

        act(() => {
            result.current.openAssistant({ ask: "first" });
        });

        const first = result.current.pendingAsk?.id as number;

        act(() => {
            result.current.openAssistant({ ask: "second" });
        });

        act(() => {
            // A stale take must not throw away the ask that arrived while it was
            // being consumed.
            result.current.takeAsk(first);
        });

        expect(result.current.pendingAsk).toBeDefined();
        expect(result.current.pendingAsk?.text).toBe("second");
    });

    it("reports unavailable until the availability probe answers, so no entry point opens early", async () => {
        expect.hasAssertions();

        // The probe is in flight on first paint. Until it answers, the deployment
        // might have no AI binding, so every entry point must read the assistant as
        // not offered rather than as ready.
        let answer: ((value: AiAvailableResult) => void) | undefined;
        const availability = new Promise<AiAvailableResult>((resolve) => {
            answer = resolve;
        });
        const pendingWrapper = ({ children }: { readonly children: ReactNode }): ReactElement => (
            <LunoraProvider
                client={
                    createMockClient({
                        query: (reference): unknown => (reference === ADMIN_FUNCTIONS.aiAvailable ? availability : undefined),
                    }).asClient
                }
            >
                <AssistantProvider>{children}</AssistantProvider>
            </LunoraProvider>
        );

        const { result } = renderHook(() => useAssistant() as AssistantValue, { wrapper: pendingWrapper });

        expect(result.current.unavailable).toBe(true);

        answer?.({ available: true, level: "schema" });

        await waitFor(() => {
            expect(result.current.unavailable).toBe(false);
        });
    });

    it("offers an insert only when a page says it has an editor", () => {
        expect.assertions(2);

        const { result } = render();

        // On a page with no editor the panel must not offer the button at all —
        // a reply on the Issues page may well contain SQL, and inserting it
        // somewhere the operator cannot see is a button that silently does nothing.
        expect(result.current.hasEditor).toBe(false);

        act(() => {
            result.current.setHasEditor(true);
        });

        expect(result.current.hasEditor).toBe(true);
    });

    it("clears an insert request only by its own id", () => {
        expect.assertions(3);

        const { result } = render();

        act(() => {
            result.current.requestInsert("SELECT 1");
        });

        const first = result.current.insertRequest?.id as number;

        act(() => {
            // The same statement offered twice is two events, not one swallowed
            // prop change — which is why the request is id-keyed rather than a bare
            // string.
            result.current.requestInsert("SELECT 1");
        });

        expect(result.current.insertRequest?.id).not.toBe(first);

        act(() => {
            result.current.takeInsert(first);
        });

        expect(result.current.insertRequest).toBeDefined();

        act(() => {
            result.current.takeInsert(result.current.insertRequest?.id as number);
        });

        expect(result.current.insertRequest).toBeUndefined();
    });
});
