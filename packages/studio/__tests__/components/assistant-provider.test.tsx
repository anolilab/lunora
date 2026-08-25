import { LunoraProvider } from "@lunora/react";
import { act, renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { AssistantValue } from "../../src/components/assistant-provider";
import { AssistantProvider, useAssistant } from "../../src/components/assistant-provider";
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
