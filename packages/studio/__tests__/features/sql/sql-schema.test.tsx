import { LunoraProvider } from "@lunora/react";
import { renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

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
