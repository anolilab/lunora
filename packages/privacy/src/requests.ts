/**
 * The request service: open, cancel and extend a data-subject request. It works
 * against a {@link RequestStore} port, so the rules are tested in memory, and the
 * app's `ctx.db` implements the port in the mutations that call this.
 *
 * Every clock value is passed in. The service never reads the wall clock, so a
 * replayed call gives the same result.
 */
import { LunoraError } from "@lunora/errors";

import type { DeadlinePolicy } from "./deadlines";
import { DEFAULT_DEADLINES, dueAt, extendedDueAt } from "./deadlines";
import type { RequestStatus, RequestType } from "./lifecycle";
import { canCancel, canExtend, erasureGraceUntil, isRequestStatus, isTerminal, transition } from "./lifecycle";

/** A request as the service sees it. */
interface RequestRecord {
    readonly dueAt: Date;
    readonly erasureGraceUntil?: Date;
    /** When the archive stops being downloadable. */
    readonly expiresAt?: Date;
    readonly extendedDueAt?: Date;
    readonly id: string;
    readonly reason?: string;
    readonly receivedAt: Date;
    readonly status: RequestStatus;
    /** Where the finished archive is kept, once the request is ready. */
    readonly storageKey?: string;
    readonly subjectId: string;
    readonly type: RequestType;
}

/**
 * A request as a workflow step returns it: every date as an ISO string, so the result survives
 * the JSON round trip a durable host stores it through. An unset field is left out, as JSON would.
 */
const toStepRecord = (record: RequestRecord): Readonly<Record<string, string>> => {
    const step: Record<string, string> = {};

    for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) {
            step[key] = value instanceof Date ? value.toISOString() : String(value);
        }
    }

    return step;
};

const malformedStep = (field: string): LunoraError => new LunoraError("INTERNAL", `A workflow step returned a privacy request with a malformed "${field}".`);

/**
 * Read a request back from its step form, with every date a `Date` again. The step store is
 * outside the package, so every field is checked here and a malformed one throws.
 */
const fromStepRecord = (step: unknown): RequestRecord => {
    if (typeof step !== "object" || step === null) {
        throw malformedStep("record");
    }

    const fields = new Map<string, unknown>(Object.entries(step));

    const text = (key: string): string => {
        const value = fields.get(key);

        if (typeof value !== "string") {
            throw malformedStep(key);
        }

        return value;
    };
    const date = (key: string): Date => {
        const value = new Date(text(key));

        if (Number.isNaN(value.getTime())) {
            throw malformedStep(key);
        }

        return value;
    };
    const has = (key: string): boolean => fields.get(key) !== undefined;

    const status = text("status");
    const type = text("type");

    if (!isRequestStatus(status)) {
        throw malformedStep("status");
    }

    if (type !== "export" && type !== "erasure") {
        throw malformedStep("type");
    }

    return {
        dueAt: date("dueAt"),
        id: text("id"),
        receivedAt: date("receivedAt"),
        status,
        subjectId: text("subjectId"),
        type,
        ...(has("erasureGraceUntil") ? { erasureGraceUntil: date("erasureGraceUntil") } : {}),
        ...(has("expiresAt") ? { expiresAt: date("expiresAt") } : {}),
        ...(has("extendedDueAt") ? { extendedDueAt: date("extendedDueAt") } : {}),
        ...(has("reason") ? { reason: text("reason") } : {}),
        ...(has("storageKey") ? { storageKey: text("storageKey") } : {}),
    };
};

/** The storage the service needs. The app implements it over `ctx.db`. */
interface RequestStore {
    addEvent: (requestId: string, at: Date, kind: string, detail?: string) => Promise<void>;

    /**
     * Apply the patch only if the request still holds `from`, and report whether it did. The host must
     * make the check and the write one step, so two callers that both read `from` cannot both win.
     */
    claim: (id: string, from: RequestStatus, patch: Partial<Omit<RequestRecord, "id">>) => Promise<boolean>;
    /** The subject's request of this type that is not yet terminal, if any. */
    findOpen: (subjectId: string, type: RequestType) => Promise<RequestRecord | undefined>;
    get: (id: string) => Promise<RequestRecord | undefined>;
    insert: (record: RequestRecord) => Promise<void>;
    /** Every request of the subject, in every status. Erasure deletes the files each one wrote. */
    listForSubject: (subjectId: string) => Promise<ReadonlyArray<RequestRecord>>;
    /** Every request that is not yet terminal, for the deadline sweep. */
    listOpen: () => Promise<ReadonlyArray<RequestRecord>>;
    update: (id: string, patch: Partial<Omit<RequestRecord, "id">>) => Promise<void>;
}

/** Inputs that come from the caller and the app's settings. */
interface ErasureSettings {
    readonly drainBudgetDays: number;
    /** The sign-in window an erasure needs, in milliseconds. Account deletion uses 24 hours. */
    readonly freshAgeMs: number;
    readonly graceDays: number;
}

const requireRequest = async (store: RequestStore, id: string): Promise<RequestRecord> => {
    const record = await store.get(id);

    if (record === undefined) {
        throw new LunoraError("NOT_FOUND", `No privacy request with id ${id}.`);
    }

    return record;
};

/** Open a request, or refuse when the subject already has one open. */
const openRequest = async (
    store: RequestStore,
    input: { deadlines?: DeadlinePolicy; erasure?: ErasureSettings; id: string; now: Date; sessionAgeMs?: number; subjectId: string; type: RequestType },
): Promise<RequestRecord> => {
    if (input.type === "erasure" && input.erasure !== undefined && (input.sessionAgeMs ?? Number.POSITIVE_INFINITY) > input.erasure.freshAgeMs) {
        throw new LunoraError("PRIVACY_SESSION_NOT_FRESH", "Sign in again to request erasure.");
    }

    const open = await store.findOpen(input.subjectId, input.type);

    // A terminal request the app's store still returns (an expired export) does not block a new one.
    if (open !== undefined && !isTerminal(open.status)) {
        throw new LunoraError("PRIVACY_REQUEST_OPEN", `This subject already has an open ${input.type} request.`);
    }

    const { erasure } = input;
    const due = dueAt(input.now, input.deadlines ?? DEFAULT_DEADLINES);
    const starts: RequestStatus = input.type === "erasure" && erasure !== undefined && erasure.graceDays > 0 ? "grace" : "received";
    const record: RequestRecord = {
        dueAt: due,
        id: input.id,
        receivedAt: input.now,
        status: starts,
        subjectId: input.subjectId,
        type: input.type,
        ...(input.type === "erasure" && erasure !== undefined
            ? { erasureGraceUntil: erasureGraceUntil(input.now, due, erasure.graceDays, erasure.drainBudgetDays) }
            : {}),
    };

    await store.insert(record);
    await store.addEvent(record.id, input.now, "received");

    return record;
};

/** Cancel a request the subject may still cancel. */
const cancelRequest = async (store: RequestStore, input: { id: string; now: Date }): Promise<RequestRecord> => {
    const record = await requireRequest(store, input.id);

    if (!canCancel(record.type, record.status)) {
        throw new LunoraError("UNPROCESSABLE", `A ${record.type} request in "${record.status}" can no longer be cancelled.`);
    }

    const status = transition(record.status, "cancelled");

    // Conditional on the status read above: a run that started in the meantime must not be overwritten.
    if (!(await store.claim(record.id, record.status, { status }))) {
        throw new LunoraError("UNPROCESSABLE", `A ${record.type} request can no longer be cancelled.`);
    }

    await store.addEvent(record.id, input.now, "cancelled");

    return { ...record, status };
};

/** Extend a request once, and only while the first month is still running. */
const extendRequest = async (store: RequestStore, input: { deadlines?: DeadlinePolicy; id: string; now: Date; reason: string }): Promise<RequestRecord> => {
    const record = await requireRequest(store, input.id);

    if (isTerminal(record.status) || !canExtend(record, input.now)) {
        throw new LunoraError("UNPROCESSABLE", "This request cannot be extended any more.");
    }

    const extended = extendedDueAt(record.receivedAt, input.deadlines ?? DEFAULT_DEADLINES);

    await store.update(record.id, { extendedDueAt: extended, reason: input.reason });
    await store.addEvent(record.id, input.now, "extended", input.reason);

    return { ...record, extendedDueAt: extended, reason: input.reason };
};

export { cancelRequest, type ErasureSettings, extendRequest, fromStepRecord, openRequest, type RequestRecord, type RequestStore, requireRequest, toStepRecord };
