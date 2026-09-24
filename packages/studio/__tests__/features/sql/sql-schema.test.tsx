import { LunoraProvider } from "@lunora/react";
import { act, renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { SqlSchema } from "../../../src/features/sql/sql-autocomplete";
import { useSqlSchema } from "../../../src/features/sql/sql-schema";
import { createMockClient } from "../../mock-client";

/** A client that answers `listTables` with a fixed pair and refuses anything else. */
const wrapper = ({ children }: { readonly children: ReactNode }): ReactElement => {
    const client = createMockClient({
        query: (reference): unknown => {
            if (reference.includes("listTables")) {
                return { tables: [{ name: "messages" }, { name: "users" }] };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

    return <LunoraProvider client={client.asClient}>{children}</LunoraProvider>;
};

describe("useSqlSchema", () => {
    it("returns a referentially stable schema across re-renders", () => {
        expect.assertions(1);

        const { rerender, result } = renderHook(() => useSqlSchema(""), { wrapper });
        const first = result.current.schema;

        rerender();
        rerender();

        /*
         * REGRESSION GUARD — this identity is behaviour, not a perf detail.
         *
         * `schema` is a dependency of the autocomplete's `refresh` callback and,
         * through it, of the SQL panel's probe-refresh effect. A fresh object per
         * render churns both identities, so that effect fires on EVERY render and
         * Escape stops dismissing the completion popover: it reopens on the next
         * render with the same suggestions at the same caret.
         *
         * This suite runs the JSX through esbuild with no React Compiler
         * transform — the same reason `refresh`'s own `useCallback` is kept — so
         * the explicit `useMemo` in `useSqlSchema` is what holds this. Deleting it
         * as "redundant under the compiler" is exactly the change this catches.
         */
        expect(result.current.schema).toBe(first);
    });
});

/**
 * A shard with one table in the canonical doc-blob shape: three physical
 * columns, with the model's fields appearing only in the DISPLAY list. `page` is
 * whatever `readTablePage` answers, so a shard that reports no physical columns
 * can be modelled too.
 */
const docWrapper =
    (page: Record<string, unknown>) =>
    ({ children }: { readonly children: ReactNode }): ReactElement => {
        const client = createMockClient({
            query: (reference): unknown => {
                if (reference.includes("listTables")) {
                    return [{ name: "posts", rowCount: 1 }];
                }

                if (reference.includes("readTablePage")) {
                    return page;
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        return <LunoraProvider client={client.asClient}>{children}</LunoraProvider>;
    };

/** Flush the hook's fire-and-forget query microtasks inside `act`, so no state update escapes it. */
const flush = async (): Promise<void> => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    });
};

/** Load the table list, then probe `posts`, settling the hook's state both times. */
const probePosts = async (result: { current: { probe: (table: string) => void } }): Promise<void> => {
    await flush();

    act(() => {
        result.current.probe("posts");
    });

    await flush();
};

describe("useSqlSchema — what counts as a column", () => {
    it("completes the physical columns and keeps the doc fields apart", async () => {
        expect.assertions(1);

        const expected: SqlSchema = {
            columns: { posts: ["id", "_creationTime", "__doc__"] },
            docFields: { posts: ["status", "zip"] },
            tables: ["posts"],
        };

        const { result } = renderHook(() => useSqlSchema(""), {
            wrapper: docWrapper({ columns: ["id", "_creationTime", "status", "zip"], rows: [], sqlColumns: ["id", "_creationTime", "__doc__"] }),
        });

        // The editor writes SQL, so it is offered the names SQL can resolve.
        // Handed the display list instead it completed `SELECT status FROM
        // posts` and the linter certified it — a statement SQLite rejects, and
        // that workerd answers with the literal string "status" once per row.
        await probePosts(result);

        expect(result.current.schema).toStrictEqual(expected);
    });

    it("leaves a table unprobed when the shard reports no physical columns", async () => {
        expect.assertions(1);

        // An older `@lunora/do` answering with the display list alone. Recording
        // it would teach the linter that `status` resolves; recording nothing
        // keeps both the linter and the completions quiet, which is the only
        // honest answer from absent knowledge.
        const expected: SqlSchema = { columns: {}, docFields: {}, tables: ["posts"] };

        const { result } = renderHook(() => useSqlSchema(""), {
            wrapper: docWrapper({ columns: ["id", "_creationTime", "status"], rows: [] }),
        });

        await probePosts(result);

        expect(result.current.schema).toStrictEqual(expected);
    });
});
