import { api } from "../../../lunora/_generated/api";
import { encryptSecret } from "../../secrets/crypto";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

interface SecretBody {
    environment?: "all" | "dev" | "preview" | "production";
    name?: string;
    organizationId?: string;
    projectId?: string;
    value?: string;
}

/**
 * `POST /v1/secrets` — set a tenant env secret (§7). Encrypts the value at the
 * edge (the master key never reaches the browser or the database in plaintext),
 * then stores ciphertext via `secrets.store` under the caller's session (so its
 * owner/admin `assertMember` gate applies).
 */
export const handleSecretRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    if (!environment.SECRET_ENCRYPTION_KEY) {
        return jsonError(500, "SECRET_ENCRYPTION_KEY not configured");
    }

    const secret = (await request.json().catch(() => null)) as SecretBody | null;

    if (!secret?.organizationId || !secret.projectId || !secret.name || typeof secret.value !== "string") {
        return jsonError(400, "organizationId, projectId, name and value are required");
    }

    // LUNORA_ADMIN_TOKEN is platform-owned and always wins at deploy time, so a
    // tenant secret with that name would be a silent no-op — reject it up front.
    if (secret.name === "LUNORA_ADMIN_TOKEN") {
        return jsonError(400, "LUNORA_ADMIN_TOKEN is a reserved secret name");
    }

    // Encryption failure is a server misconfiguration (e.g. a malformed master
    // key) → 500, kept distinct from the membership 403 the store mutation raises.
    let ciphertext: string;
    let iv: string;

    try {
        ({ ciphertext, iv } = await encryptSecret(environment.SECRET_ENCRYPTION_KEY, secret.value));
    } catch (error) {
        return jsonError(500, error instanceof Error ? error.message : "secret encryption failed");
    }

    try {
        await context.runMutation(api.secrets.store, {
            ciphertext,
            environment: secret.environment,
            iv,
            name: secret.name,
            organizationId: secret.organizationId,
            projectId: secret.projectId, // secret-scanner:allow -- domain field name
        });

        return Response.json({ ok: true });
    } catch (error) {
        return rejected(error, "set secret failed");
    }
};
