import type { CirrusClient, FunctionReference, ScheduleRecord, StorageListPage } from "@cirrus/client";
import { vi } from "vitest";

export interface MockClientHooks {
    action: ReturnType<typeof vi.fn>;
    asClient: CirrusClient;
    cancelScheduledJob: ReturnType<typeof vi.fn>;
    listScheduledJobs: ReturnType<typeof vi.fn>;
    listStorageObjects: ReturnType<typeof vi.fn>;
    mutation: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
}

type Impl = (reference: string, args: unknown, options: unknown) => unknown;

const makeMethod = (impl?: Impl): ReturnType<typeof vi.fn> =>
    vi.fn(async (fn: FunctionReference, args: unknown, options: unknown) => {
        return impl ? impl(fn.__cirrusRef, args, options) : undefined;
    });

export interface MockClientImpls {
    action?: Impl;
    cancelScheduledJob?: (id: string) => { cancelled: boolean };
    listScheduledJobs?: () => ScheduleRecord[];
    listStorageObjects?: (options: { cursor?: string; limit?: number; prefix?: string }) => StorageListPage;
    mutation?: Impl;
    query?: Impl;
}

export const createMockClient = (impls: MockClientImpls = {}): MockClientHooks => {
    const query = makeMethod(impls.query);
    const mutation = makeMethod(impls.mutation);
    const action = makeMethod(impls.action);
    const listScheduledJobs = vi.fn(async () => impls.listScheduledJobs?.() ?? []);
    const cancelScheduledJob = vi.fn(async (id: string) => impls.cancelScheduledJob?.(id) ?? { cancelled: true });
    const listStorageObjects = vi.fn(
        async (options: { cursor?: string; limit?: number; prefix?: string } = {}) => impls.listStorageObjects?.(options) ?? { objects: [] },
    );

    const asClient = {
        action,
        cancelScheduledJob,
        listScheduledJobs,
        listStorageObjects,
        mutation,
        query,
    } as unknown as CirrusClient;

    return { action, asClient, cancelScheduledJob, listScheduledJobs, listStorageObjects, mutation, query };
};
