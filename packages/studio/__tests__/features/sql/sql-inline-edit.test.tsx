import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SqlEditorPanel } from "../../../src/features/sql/sql-editor-panel";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const REWRITE = "SELECT * FROM messages ORDER BY created_at LIMIT 10";

/** A mock with the AI binding present, whose `aiGenerateSql` answers `sql`. */
const aiMock = (sql: string, available = true): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.aiAvailable) {
                return { available, level: "schema" };
            }

            if (reference === ADMIN_FUNCTIONS.aiGenerateSql) {
                return { result: { degraded: false, sql } };
            }

            if (reference === ADMIN_FUNCTIONS.listTables) {
                return [{ name: "messages", rowCount: 0 }];
            }

            return { columns: [], rowCount: 0, rows: [], truncated: false };
        },
    });

const editor = (): HTMLTextAreaElement => screen.getByTestId<HTMLTextAreaElement>("sql-input");

/** The recorded `client.query` calls for one admin function — the mock records the REFERENCE, not its path. */
const callsTo = (mock: MockClientHooks, reference: string): unknown[][] =>
    mock.query.mock.calls.filter((call: unknown[]) => (call[0] as { __lunoraRef?: string }).__lunoraRef === reference);

/** Arm the inline rewrite over the whole draft (a collapsed caret) and ask for `instruction`. */
const askFor = async (instruction: string): Promise<void> => {
    fireEvent.keyDown(editor(), { ctrlKey: true, key: "i" });
    fireEvent.change(await screen.findByTestId("sql-inline-edit-prompt"), { target: { value: instruction } });
    fireEvent.click(screen.getByTestId("sql-inline-edit-submit"));
};

describe("sql inline edit", () => {
    afterEach(() => {
        localStorage.clear();
        sessionStorage.clear();
    });

    it("rewrites the whole draft and lands the accepted proposal in the editor UNRUN", async () => {
        expect.assertions(4);

        const mock = aiMock(REWRITE);

        render(
            <LunoraProvider client={mock.asClient}>
                <SqlEditorPanel />
            </LunoraProvider>,
        );

        const before = editor().value;

        await askFor("order by created_at and limit to 10");

        // The operator's own statement travels as `editSql`, not as a failing
        // statement to repair: this one works, it just needs changing.
        const [call] = callsTo(mock, ADMIN_FUNCTIONS.aiGenerateSql);

        expect((call?.[1] as { editSql?: string } | undefined)?.editSql).toBe(before);

        const diff = await screen.findByTestId("sql-inline-diff");

        expect(diff.textContent).toContain("ORDER BY created_at");

        fireEvent.click(screen.getByTestId("sql-inline-edit-accept"));

        expect(editor().value).toBe(REWRITE);
        // Accepting is an edit, never a run — the same contract as typing it.
        expect(callsTo(mock, ADMIN_FUNCTIONS.runSql)).toHaveLength(0);
    });

    it("rewrites only the selection, leaving the rest of the draft alone", async () => {
        expect.assertions(2);

        const mock = aiMock("SELECT id");

        render(
            <LunoraProvider client={mock.asClient}>
                <SqlEditorPanel />
            </LunoraProvider>,
        );

        fireEvent.change(editor(), { target: { value: "SELECT *\nFROM messages" } });
        editor().setSelectionRange(0, 8);
        fireEvent.keyDown(editor(), { ctrlKey: true, key: "i" });

        expect(screen.getByTestId("sql-inline-edit-scope").textContent).toBe("Selection");

        fireEvent.change(screen.getByTestId("sql-inline-edit-prompt"), { target: { value: "just the id" } });
        fireEvent.click(screen.getByTestId("sql-inline-edit-submit"));

        await screen.findByTestId("sql-inline-diff");
        fireEvent.click(screen.getByTestId("sql-inline-edit-accept"));

        expect(editor().value).toBe("SELECT id\nFROM messages");
    });

    it("restores exactly what was there when the proposal is rejected", async () => {
        expect.assertions(3);

        render(
            <LunoraProvider client={aiMock(REWRITE).asClient}>
                <SqlEditorPanel />
            </LunoraProvider>,
        );

        const before = editor().value;

        await askFor("order by created_at");
        await screen.findByTestId("sql-inline-diff");

        fireEvent.click(screen.getByTestId("sql-inline-edit-reject"));

        // Rejecting drops the diff and the draft is untouched — it was never
        // written to, so "restore" is not a step that can be skipped.
        expect(screen.queryByTestId("sql-inline-diff")).toBeNull();
        expect(editor().value).toBe(before);
        // …and the instruction box is back, so a near-miss is one edit from a retry.
        expect(screen.getByTestId("sql-inline-edit-prompt")).toBeDefined();
    });

    it("closes on Escape without touching the draft", async () => {
        expect.assertions(2);

        render(
            <LunoraProvider client={aiMock(REWRITE).asClient}>
                <SqlEditorPanel />
            </LunoraProvider>,
        );

        const before = editor().value;

        fireEvent.keyDown(editor(), { ctrlKey: true, key: "i" });
        fireEvent.keyDown(await screen.findByTestId("sql-inline-edit-prompt"), { key: "Escape" });

        expect(screen.queryByTestId("sql-inline-edit")).toBeNull();
        expect(editor().value).toBe(before);
    });

    it("does not arm on a deployment that cannot run the assistant", async () => {
        expect.assertions(2);

        render(
            <LunoraProvider client={aiMock(REWRITE, false).asClient}>
                <SqlEditorPanel />
            </LunoraProvider>,
        );

        // The prompt bar hides on the same latch, so its disappearance is the
        // signal that the availability probe has answered. Waited on without an
        // `expect` so the retries don't inflate the assertion count.
        await waitFor(() => {
            if (screen.queryByTestId("sql-assistant") !== null) {
                throw new Error("the availability probe has not answered yet");
            }
        });

        expect(screen.queryByTestId("sql-assistant")).toBeNull();

        fireEvent.keyDown(editor(), { ctrlKey: true, key: "i" });

        expect(screen.queryByTestId("sql-inline-edit")).toBeNull();
    });
});
