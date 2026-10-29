import { LunoraProvider } from "@lunora/react";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import useStudioFeatures from "../../src/hooks/use-studio-features";
import { ADMIN_FUNCTIONS } from "../../src/lib/admin";
import type { MockClientHooks } from "../mock-client";
import { createMockClient } from "../mock-client";

const NODE = { id: "node", name: "Node", unsupported: ["pointInTimeRecovery"] };

const answering = (): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.studioFeatures) {
                return { platform: NODE };
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

// A worker that has not answered yet.
const silent = (): MockClientHooks =>
    createMockClient({
        query: (): unknown =>
            new Promise(() => {
                /* never settles */
            }),
    });

describe(useStudioFeatures, () => {
    it("reads as unsettled at once when the client changes, not as the previous worker's host", async () => {
        expect.assertions(2);

        let mock = answering();
        const wrapper = ({ children }: { children: ReactNode }): ReactElement => <LunoraProvider client={mock.asClient}>{children}</LunoraProvider>;
        const { rerender, result } = renderHook(() => useStudioFeatures(), { wrapper });

        await waitFor(() => {
            if (!result.current.settled) {
                throw new Error("features not settled");
            }
        });

        expect(result.current.platform?.id).toBe("node");

        mock = silent();
        rerender();

        expect([result.current.settled, result.current.platform]).toStrictEqual([false, undefined]);
    });
});
