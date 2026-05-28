import type { CirrusClient, FunctionReference } from "@cirrus/client";
import { vi } from "vitest";

export interface MockClientHooks {
    action: ReturnType<typeof vi.fn>;
    asClient: CirrusClient;
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
}

type Impl = (reference: string, args: unknown, options: unknown) => unknown;

const makeMethod = (impl?: Impl): ReturnType<typeof vi.fn> =>
    vi.fn(async (fn: FunctionReference, args: unknown, options: unknown) => {
        return impl ? impl(fn.__cirrusRef, args, options) : undefined;
    });

export const createMockClient = (impls: { action?: Impl; mutation?: Impl; query?: Impl } = {}): MockClientHooks => {
    const query = makeMethod(impls.query);
    const mutation = makeMethod(impls.mutation);
    const action = makeMethod(impls.action);

    const asClient = {
        action,
        mutation,
        query,
    } as unknown as CirrusClient;

    return { action, asClient, mutation, query };
};
