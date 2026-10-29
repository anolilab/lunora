/**
 * The `privacy_requests` row the package's schema declares, and its mapping to and from the
 * {@link RequestRecord} the services read. An app's `RequestStore` over `ctx.db` uses these, so the
 * column layout is written once, next to the table, instead of in every app.
 */
import type { RequestStatus, RequestType } from "./lifecycle";
import type { RequestRecord } from "./requests";

/** The columns of a `privacy_requests` row. Dates are epoch milliseconds; `requestId` is the package's id. */
interface RequestRow {
    readonly dueAt: number;
    readonly erasureGraceUntil?: number;
    readonly expiresAt?: number;
    readonly extendedDueAt?: number;
    readonly nothingErased?: boolean;
    readonly reason?: string;
    readonly receivedAt: number;
    readonly requestId: string;
    readonly status: RequestStatus;
    readonly storageKey?: string;
    readonly subjectId: string;
    readonly type: RequestType;
}

const toMillis = (date: Date | undefined): number | undefined => date?.getTime();

const toDate = (millis: number | undefined): Date | undefined => (millis === undefined ? undefined : new Date(millis));

/** Keep only the keys whose value is set, so an unset optional column stays unset rather than `undefined`. */
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

/** A stored row as the package sees it: every date a `Date`. */
const fromRequestRow = (row: RequestRow): RequestRecord =>
    defined({
        dueAt: new Date(row.dueAt),
        erasureGraceUntil: toDate(row.erasureGraceUntil),
        expiresAt: toDate(row.expiresAt),
        extendedDueAt: toDate(row.extendedDueAt),
        id: row.requestId,
        nothingErased: row.nothingErased,
        reason: row.reason,
        receivedAt: new Date(row.receivedAt),
        status: row.status,
        storageKey: row.storageKey,
        subjectId: row.subjectId,
        type: row.type,
    });

/** A request as the row `RequestStore.insert` writes. */
const toRequestRow = (record: RequestRecord): RequestRow =>
    defined({
        dueAt: record.dueAt.getTime(),
        erasureGraceUntil: toMillis(record.erasureGraceUntil),
        expiresAt: toMillis(record.expiresAt),
        extendedDueAt: toMillis(record.extendedDueAt),
        nothingErased: record.nothingErased,
        reason: record.reason,
        receivedAt: record.receivedAt.getTime(),
        requestId: record.id,
        status: record.status,
        storageKey: record.storageKey,
        subjectId: record.subjectId,
        type: record.type,
    });

/** A `RequestStore.update` patch as row columns. Only the keys the patch sets are written; `subjectId` is one of them. */
const toRequestPatch = (patch: Partial<Omit<RequestRecord, "id">>): Partial<Omit<RequestRow, "requestId">> =>
    defined({
        dueAt: toMillis(patch.dueAt),
        erasureGraceUntil: toMillis(patch.erasureGraceUntil),
        expiresAt: toMillis(patch.expiresAt),
        extendedDueAt: toMillis(patch.extendedDueAt),
        nothingErased: patch.nothingErased,
        reason: patch.reason,
        receivedAt: toMillis(patch.receivedAt),
        status: patch.status,
        storageKey: patch.storageKey,
        subjectId: patch.subjectId,
        type: patch.type,
    });

export { fromRequestRow, type RequestRow, toRequestPatch, toRequestRow };
