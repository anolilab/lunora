import { LunoraProvider } from "@lunora/react";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSqlDiagnostics } from "../../../src/features/sql/hooks/use-sql-diagnostics";
import type { SqlSchema } from "../../../src/features/sql/sql-autocomplete";
import { createMockClient } from "../../mock-client";

const schema: SqlSchema = { columns: { messages: ["id", "body"] }, tables: ["messages"] };

/** A client whose `lintSql` rejects, standing in for a worker that predates the RPC. */
const withoutLintSql = () =>
    createMockClient({
        query: (reference): unknown => {
            throw new Error(`unexpected ${reference}`);
        },
    });

/** Renders the hook's output as testids so assertions read against behaviour, not internals. */
const Probe = ({ draft }: { readonly draft: string }): ReactElement => {
    const diagnostics = useSqlDiagnostics(draft, schema, "");

    return (
        <ul>
            {diagnostics.map((diagnostic) => (
                <li data-testid={`diag-${diagnostic.source}`} key={`${diagnostic.source}:${diagnostic.message}`}>
                    {diagnostic.message}
                </li>
            ))}
        </ul>
    );
};

const renderProbe = (draft: string): void => {
    const mock = withoutLintSql();

    render(
        <LunoraProvider client={mock.asClient}>
            <Probe draft={draft} />
        </LunoraProvider>,
    );
};

describe("useSqlDiagnostics", () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reports client-side gate diagnostics immediately, with no round trip", () => {
        expect.assertions(2);

        renderProbe("DELETE FROM messages");

        // Synchronous: the read-only gate must never wait on the network.
        expect(screen.getAllByTestId("diag-gate")).toHaveLength(1);
        expect(screen.queryByTestId("diag-schema")).toBeNull();
    });

    it("does not ask the server to plan a statement the gate already refused", async () => {
        expect.assertions(1);

        renderProbe("DROP TABLE messages");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });

        // Still exactly the gate diagnostic — a server lint would have appended
        // a `plan` or `syntax` one.
        expect(screen.getAllByTestId("diag-gate")).toHaveLength(1);
    });

    it("stays quiet on an empty draft", async () => {
        expect.assertions(1);

        renderProbe("   ");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });

        expect(screen.queryByTestId("diag-gate")).toBeNull();
    });

    it("keeps client diagnostics when the server has no lintSql (older worker)", async () => {
        expect.assertions(2);

        renderProbe("SELECT * FROM userz");

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2000);
        });

        // The mock client rejects the unknown RPC; that must degrade to
        // client-only diagnostics, not to an error banner or an empty list.
        expect(screen.getAllByTestId("diag-schema")).toHaveLength(1);
        expect(screen.queryByTestId("diag-syntax")).toBeNull();
    });
});
