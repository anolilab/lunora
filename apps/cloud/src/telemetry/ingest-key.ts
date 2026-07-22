/**
 * Telemetry ingest-key provisioning for the deploy path. Resolves the config the
 * provisioner injects into a tenant Worker so its `otlpSink` ships back to this
 * cloud: the OTLP endpoint (a `LUNORA_OTLP_ENDPOINT` var), a scoped ingest token
 * (a `LUNORA_OTLP_TOKEN` secret), and the tail-consumer service.
 *
 * Lives here — not inline in the router factory — because it is key-lifecycle +
 * crypto business logic, not HTTP wiring: one `ingest`-capability key per org,
 * its plaintext stored envelope-encrypted so it can be re-injected on every
 * deploy without re-minting (only the hash is ever checked at ingest time).
 */
import { api } from "../../lunora/_generated/api.js";
import { formatDeployKey, hashDeployKey, randomSecret } from "../deploy/keys";
import { decryptSecret, encryptSecret } from "../secrets/crypto";

/** An AES-256-GCM envelope (mirrors `src/secrets/crypto` `EncryptedSecret`). */
interface CipherEnvelope {
    ciphertext: string;
    iv: string;
}

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
    tailConsumer?: string;
    token: string;
}

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
    input: { key: string; organizationId: string },
): Promise<TelemetryConfig | undefined> => {
    const endpoint = env.LUNORA_OTLP_ENDPOINT;
    const encryptionKey = env.SECRET_ENCRYPTION_KEY;

    if (!endpoint || !encryptionKey) {
        return undefined;
    }

    const existing = await context.runQuery<CipherEnvelope | null>(api.deploy_keys.ingestKeyCipher, {
        deployKey: input.key,
        organizationId: input.organizationId,
    });

    let cipher: CipherEnvelope;

    if (existing) {
        cipher = existing;
    } else {
        // Mint an `ingest`-capability key (telemetry-only — can't deploy), store it
        // encrypted, and use the mutation's returned effective cipher.
        const token = formatDeployKey({ organizationId: input.organizationId, secret: randomSecret(), type: "production" });
        const fresh = await encryptSecret(encryptionKey, token);

        cipher = await context.runMutation<CipherEnvelope>(api.deploy_keys.recordIngestKey, {
            deployKey: input.key,
            encryptedSecret: fresh,
            hashedKey: await hashDeployKey(token),
            organizationId: input.organizationId,
        });
    }

    return { endpoint, tailConsumer: "lunora-log-tail", token: await decryptSecret(encryptionKey, cipher) };
};
