/**
 * Telemetry ingest-key provisioning for the deploy path. Resolves the config the
 * target driver injects into a tenant Worker so its `otlpSink` ships back to this
 * cloud: the OTLP endpoint (a `LUNORA_OTLP_ENDPOINT` var) and a scoped ingest token
 * (a `LUNORA_OTLP_TOKEN` secret). Which log source the tenant is wired to (the
 * tail consumer, on `cloudflare-wfp`) is the target driver's business.
 *
 * Lives here — not inline in the router factory — because it is key-lifecycle +
 * crypto business logic, not HTTP wiring: one `ingest`-capability key per org,
 * its plaintext stored envelope-encrypted so it can be re-injected on every
 * deploy without re-minting (only the hash is ever checked at ingest time).
 *
 * A box's `lunora-hostd` forwards its own logs with the same key
 * ({@link resolveBoxTelemetryConfig}, plan 458 W6): its session Durable Object
 * reads and mints it over the control-plane store directly, as the sweeps do.
 */
import { internal } from "../../lunora/_generated/api.js";
import { formatDeployKey, hashDeployKey, randomSecret } from "../deploy/keys";
import { decryptSecret, encryptSecret } from "../secrets/crypto";
import type { ControlPlaneDatabase } from "../store";
import type { IngestKeyCipher as CipherEnvelope, IngestKeyRow } from "./ingest-key-row";
import { findActiveIngestKey, ingestKeyRow } from "./ingest-key-row";

/** The action-context slice this needs — the deploy route's Lunora context. */
interface IngestKeyContext {
    runMutation: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runQuery: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
}

/** The env slice this reads — the ingest endpoint + the secret master key. */
interface IngestKeyEnv {
    LUNORA_OTLP_ENDPOINT?: string;
    SECRET_ENCRYPTION_KEY?: string;
}

/** The telemetry config injected into a tenant Worker. */
export interface TelemetryConfig {
    endpoint: string;
    token: string;
}

/** A fresh `ingest`-capability key for `organizationId`: its hash and its envelope-encrypted plaintext. */
const mintIngestKey = async (encryptionKey: string, organizationId: string): Promise<{ encryptedSecret: CipherEnvelope; hashedKey: string }> => {
    const token = formatDeployKey({ organizationId, secret: randomSecret(), type: "production" });

    return { encryptedSecret: await encryptSecret(encryptionKey, token), hashedKey: await hashDeployKey(token) };
};

/**
 * Resolve (get-or-create) the org's ingest token and return the tenant telemetry
 * config, or `undefined` when telemetry isn't configured (no ingest endpoint or
 * no master key → deploy untelemetered). The mutation returns the **effective**
 * cipher (race-safe against a concurrent deploy), so the injected token's hash is
 * always the stored one.
 */
export const resolveTelemetryConfig = async (
    context: IngestKeyContext,
    env: IngestKeyEnv,
    input: { key?: string; organizationId: string },
): Promise<TelemetryConfig | undefined> => {
    const endpoint = env.LUNORA_OTLP_ENDPOINT;
    const encryptionKey = env.SECRET_ENCRYPTION_KEY;

    if (!endpoint || !encryptionKey) {
        return undefined;
    }

    const existing = await context.runQuery<CipherEnvelope | null>(internal.deploy_keys.ingestKeyCipher, {
        deployKey: input.key,
        organizationId: input.organizationId,
    });

    let cipher: CipherEnvelope;

    if (existing) {
        cipher = existing;
    } else if (input.key === undefined) {
        // A session caller (the studio's rollback) cannot mint the org's ingest
        // key — minting is bound to a deploy key. An org with no key has never
        // deployed with telemetry, so there is nothing to re-inject.
        return undefined;
    } else {
        // Mint an `ingest`-capability key (telemetry-only — can't deploy), store it
        // encrypted, and use the mutation's returned effective cipher.
        const { encryptedSecret, hashedKey } = await mintIngestKey(encryptionKey, input.organizationId);

        cipher = await context.runMutation<CipherEnvelope>(internal.deploy_keys.recordIngestKey, {
            deployKey: input.key,
            encryptedSecret,
            hashedKey,
            organizationId: input.organizationId,
        });
    }

    return { endpoint, token: await decryptSecret(encryptionKey, cipher) };
};

/**
 * The telemetry config a box's `lunora-hostd` forwards its own logs with
 * (protocol §5.2 `config`): this cell's OTLP endpoint and the box
 * organization's ingest key — the same pair a tenant gets — or `undefined`
 * when the cell has no telemetry configured. An organization without an ingest
 * key yet gets one, minted exactly as the deploy path mints it.
 *
 * The box session runs in a trusted system context with the store in hand and
 * no deploy key to authorize `recordIngestKey` with, so it reads and writes the
 * `deployKeys` rows directly. A mint that races a deploy's is harmless: both
 * keys are stored, and the one answered is whichever the reader finds first —
 * the same row every later read finds.
 */
export const resolveBoxTelemetryConfig = async (
    database: ControlPlaneDatabase,
    env: IngestKeyEnv,
    organizationId: string,
    now: number,
): Promise<TelemetryConfig | undefined> => {
    const endpoint = env.LUNORA_OTLP_ENDPOINT;
    const encryptionKey = env.SECRET_ENCRYPTION_KEY;

    if (!endpoint || !encryptionKey) {
        return undefined;
    }

    const activeCipher = async (): Promise<CipherEnvelope | undefined> => {
        const { page } = await database.findMany("deployKeys", { where: { organizationId } });

        return findActiveIngestKey(page as IngestKeyRow[])?.encryptedSecret ?? undefined;
    };

    let cipher = await activeCipher();

    if (cipher === undefined) {
        const { encryptedSecret, hashedKey } = await mintIngestKey(encryptionKey, organizationId);

        await database.insert("deployKeys", ingestKeyRow({ createdAt: now, encryptedSecret, hashedKey, organizationId }));
        cipher = (await activeCipher()) ?? encryptedSecret;
    }

    return { endpoint, token: await decryptSecret(encryptionKey, cipher) };
};
