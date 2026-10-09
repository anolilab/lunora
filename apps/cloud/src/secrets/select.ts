/**
 * Which of a project's stored secrets a release gets, and their plaintext — the
 * one implementation of both, shared by the deploy edge (through
 * `secrets.listEncrypted`) and the emergency stop's resume, which reads the
 * rows straight off the control-plane store (`src/deploy/halt-converge.ts`).
 */
import { LunoraError } from "@lunora/errors";

import { decryptSecret } from "./crypto";

/** A stored secret, as far as selecting and decrypting it goes. */
export interface EncryptedSecret {
    ciphertext: string;
    environment?: string;
    iv: string;
    name: string;
}

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
    rows: ReadonlyArray<Pick<EncryptedSecret, "ciphertext" | "iv" | "name">>,
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

    const entries = await Promise.all(
        rows.map(async (row): Promise<[string, string]> => [row.name, await decryptSecret(masterKey, { ciphertext: row.ciphertext, iv: row.iv })]),
    );

    return Object.fromEntries(entries);
};
