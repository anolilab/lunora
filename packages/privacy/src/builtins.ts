/**
 * Datasets for the data an app usually holds for every user: the sign-in tables,
 * the document history, the action cache and the storage objects. Each one is a
 * plain `defineDataset` call, so an app that stores these differently overrides
 * the names rather than rewriting the description.
 */
import { AUTH_DEFAULT_TABLES } from "../../../shared/privacy-coverage";
import type { Dataset } from "./dataset";
import { defineDataset } from "./dataset";

/** The better-auth table names `authDataset` covers by default. Codegen's coverage check reads the same list. */
type AuthTable = (typeof AUTH_DEFAULT_TABLES)[number];

/** The better-auth tables that hold a user's data, renamed. A table left out keeps its default name. */
type AuthTableNames = { readonly [T in AuthTable]?: string };

/** Columns the export leaves out of each auth table: credentials and tokens. */
const AUTH_OMIT: Readonly<Record<AuthTable, ReadonlyArray<string>>> = {
    account: ["password", "accessToken", "refreshToken", "idToken"],
    apikey: ["key"],
    member: [],
    passkey: [],
    session: ["token"],
    teamMember: [],
    twoFactor: ["secret", "backupCodes"],
    user: [],
};

/**
 * The sign-in dataset. Table names default to better-auth's; `@lunora/auth` does
 * not define these tables itself, so an app that renamed them passes the names.
 */
const authDataset = (names: AuthTableNames = {}): Dataset =>
    defineDataset("auth", {
        legalBasis: "contract",
        origin: "provided",
        purpose: "Sign-in identity: the account, its sessions, linked sign-in methods and second factors",
        tables: Object.fromEntries(
            AUTH_DEFAULT_TABLES.map((table) => {
                const omit = AUTH_OMIT[table];

                return [names[table] ?? table, omit.length === 0 ? {} : { omit }];
            }),
        ),
    });

/** The document history: an append-only record of past row versions, written by table triggers. */
const documentHistoryDataset = (table = "documentHistory"): Dataset =>
    defineDataset("documentHistory", {
        legalBasis: "contract",
        origin: "observed",
        purpose: "Earlier versions of the subject's rows, kept for undo and for the record of changes",
        tables: { [table]: {} },
    });

/** Cached action results. They are derived from the subject's own requests, and expire on their own. */
const actionCacheDataset = (table = "actionCache"): Dataset =>
    defineDataset("actionCache", {
        legalBasis: "legitimate_interest",
        origin: "derived",
        purpose: "Cached results of the subject's own requests, kept for a short time to save repeated work",
        tables: { [table]: {} },
    });

/** The subject's files in object storage, under the key prefix `prefix` returns for that subject. */
const storageObjectsDataset = (prefix: (subjectId: string) => string): Dataset =>
    defineDataset("storageObjects", {
        files: { prefix },
        legalBasis: "contract",
        origin: "provided",
        purpose: "Files the subject uploaded",
        tables: {},
    });

export { actionCacheDataset, authDataset, type AuthTableNames, documentHistoryDataset, storageObjectsDataset };
