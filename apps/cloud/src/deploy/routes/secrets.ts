import { api } from "../../../lunora/_generated/api";
import { sealSecret } from "../../secrets/select";
import type { RouterEnv } from "./shared";
import { jsonError, nonEmptyString, readJsonObject, rejected, requireContext } from "./shared";

const SECRET_ENVIRONMENTS = ["all", "dev", "preview", "production"] as const;

type SecretEnvironment = (typeof SECRET_ENVIRONMENTS)[number];

const isSecretEnvironment = (value: unknown): value is SecretEnvironment => SECRET_ENVIRONMENTS.includes(value as SecretEnvironment);

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

    const body = await readJsonObject(request);
    const organizationId = nonEmptyString(body?.["organizationId"]);
    const projectId = nonEmptyString(body?.["projectId"]);
    const name = nonEmptyString(body?.["name"]);
    const value = body?.["value"];
    // The environment is sealed into the ciphertext's associated data, so it is checked before sealing.
    const secretEnvironment = body?.["environment"];

    if (!organizationId || !projectId || !name || typeof value !== "string") {
        return jsonError(400, "organizationId, projectId, name and value are required strings");
    }

    if (secretEnvironment !== undefined && !isSecretEnvironment(secretEnvironment)) {
        return jsonError(400, "environment, when given, is one of all, dev, preview, production");
    }

    // LUNORA_ADMIN_TOKEN is platform-owned and always wins at deploy time, so a
    // tenant secret with that name would be a silent no-op — reject it up front.
    if (name === "LUNORA_ADMIN_TOKEN") {
        return jsonError(400, "LUNORA_ADMIN_TOKEN is a reserved secret name");
    }

    // Encryption failure is a server misconfiguration (e.g. a malformed master
    // key) → 500, kept distinct from the membership 403 the store mutation raises.
    let ciphertext: string;
    let iv: string;

    try {
        ({ ciphertext, iv } = await sealSecret(environment.SECRET_ENCRYPTION_KEY, { organizationId, projectId }, secretEnvironment ?? "all", name, value));
    } catch (error) {
        return jsonError(500, error instanceof Error ? error.message : "secret encryption failed");
    }

    try {
        await context.runMutation(api.secrets.store, {
            ciphertext,
            environment: secretEnvironment,
            iv,
            name,
            organizationId,
            projectId, // secret-scanner:allow -- domain field name
        });

        return Response.json({ ok: true });
    } catch (error) {
        return rejected(error, "set secret failed");
    }
};
