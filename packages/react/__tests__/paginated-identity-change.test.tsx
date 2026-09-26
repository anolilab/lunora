import type { FunctionReference, LunoraClient, SubscriptionError, Unsubscribe } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";

/**
 * A user switch cancels page snapshots still in flight under the retired
 * credential. A cancellation is not a failure: the hook must not report it
 * through `onError`, and must ask for the page again under the new identity.
 */

const itemsRef: FunctionReference = { __lunoraRef: "items:list" };

describe("usePaginatedQuery across an identity change", () => {
    it("refetches a page whose snapshot a user switch cancelled, without reporting an error", async () => {
        expect.hasAssertions();

        const identityListeners = new Set<() => void>();
        const answers: ((rows: string[]) => void)[] = [];
        const query = vi.fn<() => Promise<unknown>>(
            async () =>
                new Promise((resolve) => {
                    answers.push((rows) => {
                        resolve({ continueCursor: null, isDone: true, page: rows });
                    });
                }),
        );
        const client = {
            onIdentityChange: (listener: () => void): Unsubscribe => {
                identityListeners.add(listener);

                return () => {
                    identityListeners.delete(listener);
                };
            },
            query,
            subscribe: (): Unsubscribe => () => undefined,
        } as unknown as LunoraClient;
        const errors: SubscriptionError[] = [];

        const Feed = (): ReactElement => {
            const { results } = usePaginatedQuery(itemsRef, {}, { initialNumItems: 5, onError: (error) => errors.push(error) });

            return <div data-testid="rows">{(results as string[]).join(",")}</div>;
        };

        render(
            <LunoraProvider client={client}>
                <Feed />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(query).toHaveBeenCalledTimes(1);
        });

        // User A's snapshot is still in flight when the identity is retired.
        act(() => {
            for (const listener of identityListeners) {
                listener();
            }
        });

        await waitFor(() => {
            expect(query).toHaveBeenCalledTimes(2);
        });

        await act(async () => {
            answers[1]?.(["b1"]);
            await Promise.resolve();
        });

        await waitFor(() => {
            expect(screen.getByTestId("rows").textContent).toBe("b1");
        });

        expect(errors).toStrictEqual([]);
    });
});
