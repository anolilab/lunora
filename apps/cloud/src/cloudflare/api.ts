/**
 * Cloudflare REST API port (CLOUD-PLAN.md §2.2). The provisioner talks to
 * Cloudflare only through this interface, so the deploy pipeline is testable with
 * a fake and the live wire protocol lives in one place. The HTTP implementation
 * ({@link createHttpCloudflareApi}) calls the documented REST endpoints under
 * `https://api.cloudflare.com/client/v4`; swap in an Alchemy- or SDK-backed
 * implementation later without touching the provisioner.
 *
 * It is deliberately *not* exercised in this sandbox (no Cloudflare credentials);
 * the fake-backed tests cover the orchestration, and a real token makes it live.
 */

/** A binding to attach in the Workers-for-Platforms script-upload metadata. */
export type ScriptBinding =
    | { id: string; name: string; type: "d1" }
    | { bucket_name: string; name: string; type: "r2_bucket" }
    | { class_name: string; name: string; type: "durable_object_namespace" };

export interface PutScriptInput {
    bindings: ScriptBinding[];
    bundle: ArrayBuffer;
    /** Entry module file name inside the multipart upload. */
    mainModule: string;
    /** DO `new_sqlite_classes` migration tag, when the script exports DO classes. */
    migrationTag?: string;
    namespace: string;
    newSqliteClasses?: string[];
    scriptName: string;
    tags: string[];
}

export interface CloudflareApi {
    /** Create a Cloudflare-for-SaaS custom hostname for a tenant domain (§4). */
    createCustomHostname: (input: { hostname: string; zoneId: string }) => Promise<{ id: string }>;
    /** Create a D1 database; returns its uuid (the binding's `database_id`). */
    createD1Database: (name: string) => Promise<{ uuid: string }>;
    /** Create an R2 bucket (idempotent at the call site — caller ignores "exists"). */
    createR2Bucket: (name: string) => Promise<void>;
    /** Delete a D1 database by uuid (teardown). 404-tolerant (already gone). */
    deleteD1Database: (uuid: string) => Promise<void>;
    /** Remove a dispatch-namespace script (preview teardown / project deletion). */
    deleteDispatchScript: (input: { namespace: string; scriptName: string }) => Promise<void>;
    /**
     * Delete an R2 bucket by name (teardown). 404-tolerant. Throws if the bucket
     * is non-empty — R2's REST delete requires an empty bucket, and object purge
     * needs the S3/data API (a separate credential the teardown context lacks).
     */
    deleteR2Bucket: (name: string) => Promise<void>;
    /** Resolve a D1 database uuid by its name (teardown), or null if none exists. */
    findD1DatabaseByName: (name: string) => Promise<null | { uuid: string }>;
    /** Upload (create/update) a user Worker into a dispatch namespace. */
    putDispatchScript: (input: PutScriptInput) => Promise<void>;
    /** Set a secret on a dispatch-namespace script. */
    putSecret: (input: { name: string; namespace: string; scriptName: string; text: string }) => Promise<void>;
}

export interface HttpCloudflareApiOptions {
    accountId: string;
    apiToken: string;
    /** Override for tests; defaults to the public API base. */
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
}

interface CloudflareEnvelope {
    errors?: { code?: number; message?: string }[];
    result?: unknown;
    success?: boolean;
}

const DEFAULT_BASE = "https://api.cloudflare.com/client/v4";

const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

/**
 * HTTP implementation of {@link CloudflareApi}. Real code against the documented
 * REST endpoints; supply an account id + a scoped API token to run it.
 */
export const createHttpCloudflareApi = (options: HttpCloudflareApiOptions): CloudflareApi => {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const apiRoot = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE);
    const base = `${apiRoot}/accounts/${options.accountId}`;
    const authHeader = `Bearer ${options.apiToken}`;

    const callAt = async (fullUrl: string, method: string, body: unknown): Promise<unknown> => {
        const response = await fetchImpl(fullUrl, {
            body: JSON.stringify(body),
            headers: { authorization: authHeader, "content-type": "application/json" },
            method,
        });
        const data: unknown = await response.json();
        const envelope = data as CloudflareEnvelope;

        if (!response.ok || envelope.success === false) {
            const message = envelope.errors?.map((error) => error.message).join("; ") ?? `HTTP ${String(response.status)}`;

            throw new Error(`cloudflare ${method} ${fullUrl} failed: ${message}`);
        }

        return envelope.result;
    };

    const callJson = async (path: string, method: string, body: unknown): Promise<unknown> => {
        const response = await fetchImpl(`${base}${path}`, {
            body: JSON.stringify(body),
            headers: { authorization: authHeader, "content-type": "application/json" },
            method,
        });
        const data: unknown = await response.json();
        const envelope = data as CloudflareEnvelope;

        if (!response.ok || envelope.success === false) {
            const message = envelope.errors?.map((error) => error.message).join("; ") ?? `HTTP ${String(response.status)}`;

            throw new Error(`cloudflare ${method} ${path} failed: ${message}`);
        }

        return envelope.result;
    };

    return {
        createCustomHostname: async ({ hostname, zoneId }) => {
            const result = (await callAt(`${apiRoot}/zones/${zoneId}/custom_hostnames`, "POST", { hostname, ssl: { method: "http", type: "dv" } })) as {
                id?: string;
            };

            if (!result.id) {
                throw new Error("cloudflare custom hostname create returned no id");
            }

            return { id: result.id };
        },
        createD1Database: async (name) => {
            const result = (await callJson("/d1/database", "POST", { name })) as { uuid?: string };

            if (!result.uuid) {
                throw new Error("cloudflare D1 create returned no uuid");
            }

            return { uuid: result.uuid };
        },
        createR2Bucket: async (name) => {
            await callJson("/r2/buckets", "POST", { name });
        },
        deleteD1Database: async (uuid) => {
            const response = await fetchImpl(`${base}/d1/database/${uuid}`, { headers: { authorization: authHeader }, method: "DELETE" });

            if (!response.ok && response.status !== 404) {
                throw new Error(`cloudflare delete D1 failed: HTTP ${String(response.status)}`);
            }
        },
        deleteDispatchScript: async ({ namespace, scriptName }) => {
            const response = await fetchImpl(`${base}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`, {
                headers: { authorization: authHeader },
                method: "DELETE",
            });

            if (!response.ok && response.status !== 404) {
                throw new Error(`cloudflare delete script failed: HTTP ${String(response.status)}`);
            }
        },
        deleteR2Bucket: async (name) => {
            const response = await fetchImpl(`${base}/r2/buckets/${name}`, { headers: { authorization: authHeader }, method: "DELETE" });

            if (!response.ok && response.status !== 404) {
                const detail = await response.text().catch(() => "");

                throw new Error(`cloudflare delete R2 bucket failed: HTTP ${String(response.status)}${detail ? `: ${detail}` : ""}`);
            }
        },
        findD1DatabaseByName: async (name) => {
            const result = (await callJson(`/d1/database?name=${encodeURIComponent(name)}`, "GET", undefined)) as { name?: string; uuid?: string }[] | undefined;
            const match = (result ?? []).find((database) => database.name === name && typeof database.uuid === "string");

            return match?.uuid ? { uuid: match.uuid } : null;
        },
        putDispatchScript: async (input) => {
            // Workers-for-Platforms multipart upload: a `metadata` part (bindings,
            // main_module, migrations, tags) + the bundle module part.
            const metadata = {
                bindings: input.bindings,
                compatibility_date: "2026-06-10",
                compatibility_flags: ["nodejs_compat"],
                main_module: input.mainModule,
                ...(input.newSqliteClasses && input.newSqliteClasses.length > 0
                    ? { migrations: { new_sqlite_classes: input.newSqliteClasses, new_tag: input.migrationTag ?? "v1" } }
                    : {}),
                tags: input.tags,
            };

            const form = new FormData();

            form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
            form.set(input.mainModule, new Blob([input.bundle], { type: "application/javascript+module" }), input.mainModule);

            const response = await fetchImpl(`${base}/workers/dispatch/namespaces/${input.namespace}/scripts/${input.scriptName}`, {
                body: form,
                headers: { authorization: authHeader },
                method: "PUT",
            });

            if (!response.ok) {
                const detail = await response.text().catch(() => "");

                throw new Error(`cloudflare put script failed: HTTP ${String(response.status)}${detail ? `: ${detail}` : ""}`);
            }
        },
        putSecret: async ({ name, namespace, scriptName, text }) => {
            await callJson(`/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/secrets`, "PUT", { name, text, type: "secret_text" });
        },
    };
};
