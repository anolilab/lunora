/**
 * What an organization's platform-managed ingest key is, as a `deployKeys` row:
 * the one definition both writers share — `deploy_keys.recordIngestKey` (the
 * deploy path, authorized by a deploy key) and the box session
 * (`src/telemetry/ingest-key.ts` `resolveBoxTelemetryConfig`, a trusted system
 * context with the store in hand) — so the reader and the writers can never
 * drift apart. Dependency-free: `lunora/` imports it too.
 */

/** An AES-256-GCM envelope (mirrors `src/secrets/crypto` `EncryptedSecret`). */
export interface IngestKeyCipher {
    ciphertext: string;
    iv: string;
}

/** One `deployKeys` row as the ingest-key helpers read it. `.global()` rows answer SQL NULL for an unset column. */
export interface IngestKeyRow {
    capability?: "deploy" | "ingest" | null;
    encryptedSecret?: IngestKeyCipher | null;
    projectId?: null | string;
    revokedAt?: null | number;
}

/**
 * The live ingest key among an organization's `deployKeys` rows, if any: an
 * `ingest`-capability, non-revoked row that carries its encrypted secret, of
 * `projectId` — or, without one, the organization-wide key a box forwards with.
 *
 * A tenant's key is its project's. The token is injected into the Worker's env,
 * so whoever may deploy the project can read it; an organization-wide one let
 * a project-scoped deploy key ship code that wrote telemetry as every sibling
 * project (`assertTelemetryInKeyProject` passes an org-wide key everywhere).
 */
export const findActiveIngestKey = <T extends IngestKeyRow>(rows: ReadonlyArray<T>, projectId?: string): T | undefined =>
    rows.find(
        (candidate) =>
            candidate.capability === "ingest" &&
            candidate.revokedAt == null &&
            candidate.encryptedSecret != null &&
            (candidate.projectId ?? undefined) === projectId,
    );

/** The `deployKeys` row of a freshly minted ingest key: telemetry-only, so it can never deploy. */
export const ingestKeyRow = <O extends string, P extends string = never>(input: {
    createdAt: number;
    encryptedSecret: IngestKeyCipher;
    hashedKey: string;
    organizationId: O;
    projectId?: P;
}): {
    capability: "ingest";
    createdAt: number;
    encryptedSecret: IngestKeyCipher;
    hashedKey: string;
    name: string;
    organizationId: O;
    projectId?: P;
    type: "production";
} => {
    return {
        capability: "ingest",
        createdAt: input.createdAt,
        encryptedSecret: input.encryptedSecret,
        hashedKey: input.hashedKey,
        name: "Telemetry ingest (auto)",
        organizationId: input.organizationId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        type: "production",
    };
};
