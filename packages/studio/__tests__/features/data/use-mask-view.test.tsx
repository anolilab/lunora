import { LunoraProvider } from "@lunora/react";
import { renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useMaskView } from "../../../src/features/data/hooks/use-mask-view";
import { maskRow } from "../../../src/lib/mask-preview";
import { createMockClient } from "../../mock-client";

/**
 * Deployment-wide policies: `users.salary` is redacted, and the BROWSED table
 * (`messages`) has none of its own. That asymmetry is the point — the foreign-key
 * hover preview fetches a row from `users` while the operator is browsing
 * `messages`, so the open table's view says nothing about what to hide.
 *
 * `salary` and not `apiKey` on purpose. `mergeSensitiveColumns` layers a NAME
 * heuristic over the declared policies, and every credential-shaped name is caught
 * by that heuristic whichever table is looked up — so a test using one passes even
 * when the lookup is wrong, which is how the first version of this test asserted
 * the fix while proving nothing about it. `salary` is covered only by the explicit
 * policy, so it fails the moment the target table stops being consulted.
 */
const wrapper = ({ children }: { readonly children: ReactNode }): ReactElement => {
    const client = createMockClient({
        query: (): unknown => {
            return { columns: [{ column: "salary", strategy: "redact", table: "users" }] };
        },
    });

    return <LunoraProvider client={client.asClient}>{children}</LunoraProvider>;
};

const renderMaskView = () => renderHook(() => useMaskView({ columns: ["id", "body"], selectedTable: "messages" }), { wrapper });

describe("useMaskView — foreign-key preview target", () => {
    it("masks a covered column of the TARGET table, which the browsed table's view does not cover", async () => {
        expect.assertions(3);

        const { result } = renderMaskView();

        // The policy query resolves after mount. Waited on WITHOUT an `expect`,
        // because `waitFor` retries its callback and each retry would count against
        // `expect.assertions`.
        await vi.waitFor(() => {
            if (!result.current.maskViewFor("users", ["id", "salary"]).columns.has("salary")) {
                throw new Error("mask policies not loaded yet");
            }
        });

        expect(result.current.maskViewFor("users", ["id", "salary"]).columns.has("salary")).toBe(true);

        // The browsed table's own view knows nothing about `users.salary` — this is
        // exactly why the preview leaked: it rendered with no view at all, and the
        // open table's view would not have covered it either.
        expect(result.current.maskView.columns.has("salary")).toBe(false);

        const previewRow = { id: "u1", salary: 145_000 };
        const masked = maskRow(previewRow, result.current.maskViewFor("users", Object.keys(previewRow)));

        expect(masked.salary).toBeNull();
    });
});
