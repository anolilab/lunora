/**
 * Datasets for the data an app usually holds for every user: the sign-in tables,
 * the document history, the action cache and the storage objects. Each one is a
 * plain `defineDataset` call, so an app that stores these differently overrides
 * the names rather than rewriting the description.
 */
import type { Dataset } from "./dataset";
import { defineDataset } from "./dataset";

/** The better-auth tables that hold a user's data, by their default names. */
interface AuthTableNames {
    readonly account?: string;
    readonly apikey?: string;
    readonly member?: string;
    readonly passkey?: string;
    readonly session?: string;
    readonly teamMember?: string;
    readonly twoFactor?: string;
    readonly user?: string;
}

/**
 * The sign-in dataset. Table names default to better-auth's; `@lunora/auth` does
 * not define these tables itself, so an app that renamed them passes the names.
 */
const authDataset = (names: AuthTableNames = {}): Dataset =>
    defineDataset("auth", {
        legalBasis: "contract",
        origin: "provided",
        purpose: "Sign-in identity: the account, its sessions, linked sign-in methods and second factors",
        tables: {
            [names.account ?? "account"]: { omit: ["password", "accessToken", "refreshToken", "idToken"] },
            [names.apikey ?? "apikey"]: { omit: ["key"] },
            [names.member ?? "member"]: {},
            [names.passkey ?? "passkey"]: {},
            [names.session ?? "session"]: { omit: ["token"] },
            [names.teamMember ?? "teamMember"]: {},
            [names.twoFactor ?? "twoFactor"]: { omit: ["secret", "backupCodes"] },
            [names.user ?? "user"]: {},
        },
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

/** The subject's files in object storage, under a key prefix the app assigns to the subject. */
const storageObjectsDataset = (prefix: string): Dataset =>
    defineDataset("storageObjects", {
        files: { prefix },
        legalBasis: "contract",
        origin: "provided",
        purpose: "Files the subject uploaded",
        tables: {},
    });

export { actionCacheDataset, authDataset, type AuthTableNames, documentHistoryDataset, storageObjectsDataset };
