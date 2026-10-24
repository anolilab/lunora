/**
 * The ports an app implements and binds once per invocation: its data, one dataset at a time, the
 * file store, the archive of kept rows, and the request store. The runs, the bound API and the
 * workflow wire all read these declarations.
 */
import type { Dataset } from "./dataset";
import type { RowDisposition } from "./erasure";
import type { RequestStore } from "./requests";
import type { TombstonePort } from "./tombstones";

/** The app's data, one dataset at a time. The app implements it over its tables. */
interface DataPort {
    /** The subject's rows for each table of the dataset, keyed by table name. */
    readonly collect: (dataset: Dataset, subjectId: string) => Promise<Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>>;

    /**
     * Erase one batch of the dataset's rows for the subject. The package decides and the app
     * writes: call `disposition` for each row, then delete a `delete` row, anonymise an
     * `anonymise` row, and move a `keep` row into the archive table. A kept row must not be
     * selected again, or the drain never finishes.
     */
    readonly eraseBatch: (dataset: Dataset, subjectId: string, now: Date, disposition: RowDisposition) => Promise<{ readonly hasMore: boolean }>;

    /**
     * Rows still present per table after erasure, for the verify step. Two kinds of row may be
     * counted and are excluded from the verdict by the package: a row a retention rule still keeps
     * (verify judges each one again through `collect`), and every row of an `anonymise` table, which
     * stays in place once anonymised. Prefer not to count anonymised rows at all; the package cannot
     * tell an anonymised row from one `eraseBatch` missed, so it does not hold them against the erasure.
     */
    readonly remaining: (dataset: Dataset, subjectId: string) => Promise<Readonly<Record<string, number>>>;
}

/**
 * Where a request's files are kept between steps and in the end. `put` must key a request's
 * files under `${requestId}/` and keep the file's name in the key, so listing that prefix finds
 * every file the request wrote and an export run finds its own by the id its names start with.
 */
interface StorePort {
    /** Remove one stored object. Removing a key that is not there is not an error. */
    readonly delete: (key: string) => Promise<void>;
    /** The keys of every stored object whose key starts with the prefix. */
    readonly list: (prefix: string) => Promise<ReadonlyArray<string>>;
    readonly put: (requestId: string, file: { readonly data: Uint8Array | string; readonly name: string }) => Promise<string>;
    /** The text of a file written earlier in the same request, or `undefined` if it is not there. */
    readonly read: (requestId: string, name: string) => Promise<string | undefined>;
    /** A short-lived link to a stored file. The caller decides the lifetime, and the link is checked by the host. */
    readonly signedUrl: (key: string, ttlSeconds: number) => Promise<string>;
}

/**
 * The archive of rows erasure kept under a retention rule (`privacy_archive`, or the app's own
 * table). The app writes a `keep` row into it with the `until` its disposition carries as
 * `retainUntil`; the sweep purges it once that date has passed.
 */
interface ArchivePort {
    /**
     * Delete up to `ERASE_BATCH` archived rows whose `retainUntil` is before `before`, and say how
     * many it deleted and whether more may remain.
     */
    readonly purgeBatch: (before: Date) => Promise<{ readonly hasMore: boolean; readonly purged: number }>;
}

/** The ports one invocation binds: the app's data, storage, requests and clock. */
interface PrivacyPorts {
    /** Where kept rows wait out their retention period. Required for `admin.sweep` once a dataset uses `retain`. */
    readonly archive?: ArchivePort;
    readonly data: DataPort;
    readonly files: StorePort;
    readonly newId: () => string;
    readonly now: () => Date;
    readonly store: RequestStore;

    /**
     * Where erased subjects are tombstoned, so a restored backup can be erased again. An erasure and
     * `restore` refuse to run without it; a call that only exports or reads may leave it out.
     */
    readonly tombstones?: TombstonePort;
}

export type { ArchivePort, DataPort, PrivacyPorts, StorePort };
