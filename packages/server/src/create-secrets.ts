/**
 * `ctx.secrets` — a thin, typed reader over Cloudflare Secrets Store bindings.
 * A core built-in (always on every context): `get(name)` resolves the worker
 * `env[name]` Secrets Store binding and reads its value.
 *
 * Node-safe (structural binding type) so it's exercised by unit tests with
 * plain-object doubles.
 */
import { LunoraError } from "@lunora/errors";

import type { Secrets, SecretsStoreSecretLike } from "./types";

/**
 * Methods that disambiguate a *non*-Secrets-Store binding from a Secrets Store
 * one. A `SecretsStoreSecret`'s entire surface is `get(): Promise<string>`, but
 * `.get` is NOT unique to it — a KV namespace (`get(key)`), an R2 bucket
 * (`get(key)`), a Durable Object namespace (`get(id)`), a Queue producer, and an
 * Analytics dataset all expose `.get` or other methods. So a bare `{ get }`
 * structural check would happily call `env.MY_KV.get()` and return a KV read
 * instead of the promised directed error. We reject any binding that carries one
 * of these other-binding methods, keeping the "no Secrets Store binding named X"
 * error meaningful for the common name collisions.
 */
const NON_SECRET_BINDING_METHODS = [
    "put", // KV / R2
    "list", // KV / R2
    "delete", // KV / R2
    "getWithMetadata", // KV
    "head", // R2
    "createMultipartUpload", // R2
    "idFromName", // Durable Object namespace
    "newUniqueId", // Durable Object namespace
    "getByName", // Durable Object namespace
    "send", // Queue producer
    "sendBatch", // Queue producer
    "writeDataPoint", // Analytics Engine dataset
    "create", // Workflows binding (get(id) + create/createBatch)
    "createBatch", // Workflows binding
] as const;

/** True when a value structurally matches a Secrets Store binding (`{ get(): Promise<string> }`) and not another `.get`-bearing binding. */
const isSecretBinding = (value: unknown): value is SecretsStoreSecretLike => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const record = value as Record<string, unknown>;

    if (typeof record.get !== "function") {
        return false;
    }

    return !NON_SECRET_BINDING_METHODS.some((method) => typeof record[method] === "function");
};

/**
 * Build the `ctx.secrets` reader from the worker `env`. `get(name)` resolves
 * `env[name].get()` — the `secrets_store_secrets[]` binding of that name. An
 * absent or non-Secrets-Store binding throws a directed error pointing at the
 * wrangler config; the lookup is lazy, so an unused secret never resolves.
 */
// eslint-disable-next-line import/prefer-default-export -- named export by package convention; src/index.ts re-exports it
export const createSecrets = (env: Record<string, unknown>): Secrets => {
    return {
        get: async (name: string): Promise<string> => {
            const binding = env[name];

            if (!isSecretBinding(binding)) {
                throw new LunoraError(
                    "INTERNAL",
                    `ctx.secrets: no Secrets Store binding named "${name}". Add a \`secrets_store_secrets[]\` entry (binding "${name}", pointing at your store + secret) to wrangler.jsonc — \`ctx.secrets\` reads a Secrets Store binding, not a plain \`.dev.vars\` value.`,
                );
            }

            return binding.get();
        },
    };
};
