/**
 * Deploy-key format + crypto helpers (CLOUD-PLAN.md §2.2). A key encodes its
 * own target so the deploy API can resolve org/project from the key alone,
 * shaped `type:organizationId[:projectId]|secret`. Only the SHA-256 hash is
 * ever stored; the plaintext is shown once at issuance.
 */

export type DeployKeyType = "dev" | "preview" | "production";

export interface ParsedDeployKey {
    organizationId: string;
    projectId?: string;
    secret: string;
    type: DeployKeyType;
}

const DEPLOY_KEY_RE = /^(production|dev|preview):([^|]+)\|(.+)$/u;

const toHex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** A fresh 256-bit secret, hex-encoded. */
export const randomSecret = (): string => {
    const bytes = new Uint8Array(32);

    crypto.getRandomValues(bytes);

    return toHex(bytes.buffer);
};

/** SHA-256 hex of an arbitrary string — the storage form for any bearer secret. */
export const sha256Hex = async (input: string): Promise<string> => toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));

/** SHA-256 hex of the full key string — what gets stored and compared. */
export const hashDeployKey = (key: string): Promise<string> => sha256Hex(key);

export const formatDeployKey = (parts: Omit<ParsedDeployKey, "secret"> & { secret: string }): string => {
    const scope = parts.projectId ? `${parts.organizationId}:${parts.projectId}` : parts.organizationId;

    return `${parts.type}:${scope}|${parts.secret}`;
};

/** Parse a presented key back into its parts, or `null` if malformed. */
export const parseDeployKey = (key: string): ParsedDeployKey | null => {
    const match = DEPLOY_KEY_RE.exec(key);

    if (!match) {
        return null;
    }

    const type = match[1] as DeployKeyType;
    const [organizationId, projectId] = (match[2] ?? "").split(":");
    const secret = match[3] ?? "";

    if (!organizationId) {
        return null;
    }

    return { organizationId, ...(projectId ? { projectId } : {}), secret, type };
};
