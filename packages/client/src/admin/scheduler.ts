import { decodeWire } from "@lunora/wire";

import { collectPages } from "../../../../shared/collect-pages";
import {
    SCHEDULED_CANCEL_PATH,
    SCHEDULED_DEAD_CANCEL_PATH,
    SCHEDULED_DEAD_PATH,
    SCHEDULED_DEAD_RETRY_PATH,
    SCHEDULED_PATH,
    SCHEDULED_STATUS_PATH,
    WORKFLOWS_INSTANCE_PATH,
    WORKFLOWS_INSTANCES_PATH,
    WORKFLOWS_STATUS_PATH,
} from "../client-paths";
import type { LunoraClient } from "../lunora-client";
import type { ScheduleRecord, SchedulerStatus, WorkflowInstanceDetail, WorkflowInstancePage, WorkflowInstanceStatus } from "../types";
import type { AdminHost } from "./host";

/**
 * Undo the scheduler's `encodeWire(args)` on a record read back off the admin
 * routes, so `listScheduledJobs` / `listDeadJobs` / `subscribeScheduledJobs`
 * answer the same values `@lunora/scheduler`'s `createScheduler.list()` answers
 * a shard-side reader for the SAME record.
 *
 * The decode has to happen HERE and not in the worker's admin proxy: that proxy
 * re-serializes with `JSON.stringify`, which throws on the very `bigint` the
 * encode exists to carry, so decoding on the way through would turn a job with a
 * `bigint` argument into a 500. Identity for pure-JSON args.
 */
export const decodeRecordArgs = (record: ScheduleRecord): ScheduleRecord =>
    "args" in record ? { ...record, args: decodeWire(record.args) as Record<string, unknown> } : record;

export const listScheduledJobs = async (host: AdminHost): ReturnType<LunoraClient["listScheduledJobs"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(SCHEDULED_PATH, "GET")) as { records?: ScheduleRecord[] };

    return (body.records ?? []).map((record) => decodeRecordArgs(record));
};

export const schedulerStatus = async (host: AdminHost): ReturnType<LunoraClient["schedulerStatus"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(SCHEDULED_STATUS_PATH, "GET")) as Partial<SchedulerStatus>;

    return {
        backlog: body.backlog ?? 0,
        inFlight: body.inFlight ?? 0,
        pools: body.pools ?? [],
    };
};

export const cancelScheduledJob = async (
    host: AdminHost,
    id: Parameters<LunoraClient["cancelScheduledJob"]>[0],
): ReturnType<LunoraClient["cancelScheduledJob"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(SCHEDULED_CANCEL_PATH, "POST", { id })) as { cancelled?: boolean };

    return { cancelled: body.cancelled === true };
};

export const listDeadJobs = async (host: AdminHost): ReturnType<LunoraClient["listDeadJobs"]> => {
    host.assertOpen();

    // Walk every page. `/dead` became a bounded, cursored read so a shard
    // that dead-lettered thousands of jobs over a weekend cannot fail to
    // serialize them in one response — but the studio's dead-letter panel is
    // the ONLY view of a permanently-failed job and the only way to requeue
    // one, so stopping at the first page would hide exactly the backlog the
    // operator opened it for. Returning `records` alone made this silently
    // truncate the moment the route grew its limit.
    const records = await collectPages<ScheduleRecord>(
        async (cursor) =>
            (await host.adminFetch(cursor === undefined ? SCHEDULED_DEAD_PATH : `${SCHEDULED_DEAD_PATH}?cursor=${encodeURIComponent(cursor)}`, "GET")) as {
                cursor?: string;
                records?: ScheduleRecord[];
                truncated?: boolean;
            },
    );

    return records.map((record) => decodeRecordArgs(record));
};

export const retryDeadJob = async (host: AdminHost, id: Parameters<LunoraClient["retryDeadJob"]>[0]): ReturnType<LunoraClient["retryDeadJob"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(SCHEDULED_DEAD_RETRY_PATH, "POST", { id })) as { retried?: boolean };

    return { retried: body.retried === true };
};

export const removeDeadJob = async (host: AdminHost, id: Parameters<LunoraClient["removeDeadJob"]>[0]): ReturnType<LunoraClient["removeDeadJob"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(SCHEDULED_DEAD_CANCEL_PATH, "POST", { id })) as { removed?: boolean };

    return { removed: body.removed === true };
};

export const listWorkflowInstances = async (
    host: AdminHost,
    options: Parameters<LunoraClient["listWorkflowInstances"]>[0],
): ReturnType<LunoraClient["listWorkflowInstances"]> => {
    host.assertOpen();

    const query = new URLSearchParams({ name: options.name });

    if (options.status !== undefined) {
        query.set("status", options.status);
    }

    if (options.page !== undefined) {
        query.set("page", String(options.page));
    }

    if (options.perPage !== undefined) {
        query.set("perPage", String(options.perPage));
    }

    const body = (await host.adminFetch(`${WORKFLOWS_INSTANCES_PATH}?${query.toString()}`, "GET")) as Partial<WorkflowInstancePage>;

    return {
        configured: body.configured,
        instances: body.instances ?? [],
        page: body.page ?? 1,
        perPage: body.perPage ?? options.perPage ?? 0,
        totalCount: body.totalCount,
    };
};

export const getWorkflowInstance = async (
    host: AdminHost,
    options: Parameters<LunoraClient["getWorkflowInstance"]>[0],
): ReturnType<LunoraClient["getWorkflowInstance"]> => {
    host.assertOpen();

    const query = new URLSearchParams({ id: options.id, name: options.name });
    const body = (await host.adminFetch(`${WORKFLOWS_INSTANCE_PATH}?${query.toString()}`, "GET")) as Partial<WorkflowInstanceDetail>;

    return {
        createdOn: body.createdOn,
        endedOn: body.endedOn,
        error: body.error,
        id: body.id ?? options.id,
        output: body.output,
        params: body.params,
        startedOn: body.startedOn,
        status: body.status ?? "unknown",
        steps: body.steps ?? [],
    };
};

export const setWorkflowInstanceStatus = async (
    host: AdminHost,
    options: Parameters<LunoraClient["setWorkflowInstanceStatus"]>[0],
): ReturnType<LunoraClient["setWorkflowInstanceStatus"]> => {
    host.assertOpen();

    const body = (await host.adminFetch(WORKFLOWS_STATUS_PATH, "POST", { action: options.action, id: options.id, name: options.name })) as {
        status?: WorkflowInstanceStatus;
    };

    return { status: body.status ?? "unknown" };
};
