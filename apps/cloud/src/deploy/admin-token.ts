/**
 * Deployment admin-token at-rest encryption (CLOUD-PLAN.md §3 / §7). The
 * platform mints a per-deployment admin token — the bearer the hosted-studio
 * admin proxy and the cron/queue fan-out present to a tenant Worker's
 * `/_lunora/*`. It used to be stored in plaintext in the control-plane D1, so a
 * database leak handed over every tenant. It is now sealed with the same
 * AES-256-GCM master key (`SECRET_ENCRYPTION_KEY`) as tenant secrets before
 * storage; only ciphertext + a per-token IV reach the database.
 *
 * A plaintext fallback is kept for local dev where no master key is configured
 * (the same posture the tenant-secret path takes — encryption engages the moment
 * a key is present). Pure over the key, so both the edge (router) and the
 * scheduled Worker (fan-out) share one seal/resolve implementation.
 */
import { decryptSecret, encryptSecret } from "../secrets/crypto";

/** The admin-token fields stored on a deployment row — sealed when a key is configured, else plaintext. */
export interface StoredAdminToken {
    /** Plaintext fallback — only written when no `SECRET_ENCRYPTION_KEY` is set (dev). */
    adminToken?: string;
    /** Base64 AES-256-GCM ciphertext of the admin token. */
    adminTokenCiphertext?: string;
    /** Base64 IV for {@link adminTokenCiphertext}. */
    adminTokenIv?: string;
}

/**
 * Seal a freshly-minted admin token for storage: encrypted fields when a master
 * key is present, the plaintext field otherwise. The returned object is spread
 * straight into the `deployments.create` args.
 */
export const sealAdminToken = async (token: string, keyHex?: string): Promise<StoredAdminToken> => {
    if (!keyHex) {
        return { adminToken: token };
    }

    const { ciphertext, iv } = await encryptSecret(keyHex, token);

    return { adminTokenCiphertext: ciphertext, adminTokenIv: iv };
};

/**
 * Recover the plaintext admin token from a stored row. Decrypts when sealed
 * (returns `undefined` if sealed but no key is available — never leaks
 * ciphertext as if it were the token), else returns the plaintext fallback.
 */
export const resolveAdminToken = async (row: StoredAdminToken, keyHex?: string): Promise<string | undefined> => {
    if (row.adminTokenCiphertext && row.adminTokenIv) {
        if (!keyHex) {
            return undefined;
        }

        return decryptSecret(keyHex, { ciphertext: row.adminTokenCiphertext, iv: row.adminTokenIv });
    }

    return row.adminToken;
};
