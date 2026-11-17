/**
 * Which of a project's stored secrets a release gets, and their plaintext — the
 * one implementation of both, shared by the deploy edge (through
 * `secrets.listEncrypted`) and the emergency stop's resume, which reads the
 * rows straight off the control-plane store (`src/deploy/halt-converge.ts`).
 */
import { LunoraError } from "@lunora/errors";

import type { EncryptedSecret as Sealed } from "./crypto";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * The `cipherVersion` of a row sealed with {@link secretAad}. A row without one
 * was encrypted before the binding and still decrypts without it; the next write
 * of that secret replaces it with a bound one.
 */
export const SECRET_CIPHER_VERSION = 2 as const;

/** The project a set of secret rows belongs to. */
export interface SecretScope {
    organizationId: string;
    projectId: string;
}

/** A stored secret, as far as selecting and decrypting it goes. */
export interface EncryptedSecret {
    ciphertext: string;
    cipherVersion?: null | number;
    environment: string;
    iv: string;
    name: string;
}

/**
 * The additional data a secret's ciphertext is bound to. Owners and admins can
 * read a project's ciphertext and write any ciphertext into a secret, so without
 * it a value sealed for one organization's secret decrypts in another's deploy.
 */
export const secretAad = (scope: SecretScope, environment: string, name: string): string =>
    [scope.organizationId, scope.projectId, environment, name].join("\0");

/** Encrypt `plaintext` for the secret `name` of `environment` in `scope`. */
export const sealSecret = async (
    masterKey: string,
    scope: SecretScope,
    environment: string,
    name: string,
    plaintext: string,
): Promise<Sealed & { cipherVersion: typeof SECRET_CIPHER_VERSION }> => {
    return { ...(await encryptSecret(masterKey, plaintext, secretAad(scope, environment, name))), cipherVersion: SECRET_CIPHER_VERSION };
};

/** Decrypt one stored row of `scope`, bound or (for a row written before the binding) not. */
export const openSecret = (
    masterKey: string,
    scope: SecretScope,
    row: Pick<EncryptedSecret, "ciphertext" | "cipherVersion" | "environment" | "iv" | "name">,
): Promise<string> =>
    decryptSecret(
        masterKey,
        { ciphertext: row.ciphertext, iv: row.iv },
        row.cipherVersion === SECRET_CIPHER_VERSION ? secretAad(scope, row.environment, row.name) : undefined,
    );

/**
 * The secrets a release of `kind` gets: every row of that kind or `all`, a
 * kind-specific row overriding a shared (`all`) row of the same name.
 */
export const secretsForKind = <Row extends EncryptedSecret>(rows: ReadonlyArray<Row>, kind: string): Row[] => {
    const byName = new Map<string, Row>();

    for (const secret of rows) {
        if (secret.environment !== kind && secret.environment !== "all") {
            continue;
        }

        const existing = byName.get(secret.name);

        if (!existing || (existing.environment === "all" && secret.environment !== "all")) {
            byName.set(secret.name, secret);
        }
    }

    return [...byName.values()];
};

/**
 * Decrypt the selected rows into the tenant Worker's secrets.
 *
 * The rows are read FIRST, then the master key decides. Returning `{}` on a
 * missing key meant a control plane whose key was removed, rotated badly, or
 * never set in one cell shipped tenant Workers with none of their secrets —
 * silently, reported as a successful release. With no secrets stored there is
 * nothing to drop and the deploy is genuinely fine, so only the contradiction fails.
 * @throws {LunoraError} `INTERNAL` when there are secrets and no key to decrypt them.
 */
export const decryptSecrets = async (
    rows: ReadonlyArray<Pick<EncryptedSecret, "ciphertext" | "cipherVersion" | "environment" | "iv" | "name">>,
    scope: SecretScope,
    masterKey: string | undefined,
): Promise<Record<string, string>> => {
    if (!masterKey) {
        if (rows.length > 0) {
            throw new LunoraError(
                "INTERNAL",
                `this project has ${String(rows.length)} stored secret(s) but the control plane has no SECRET_ENCRYPTION_KEY to decrypt them — deploying would ship a Worker with none of them`,
            );
        }

        return {};
    }

    const entries = await Promise.all(rows.map(async (row): Promise<[string, string]> => [row.name, await openSecret(masterKey, scope, row)]));

    return Object.fromEntries(entries);
};
