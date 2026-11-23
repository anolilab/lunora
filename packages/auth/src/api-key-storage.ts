/**
 * Where the plugin's own options put the keys of one configuration. better-auth keeps
 * the resolved options inside the plugin's closures, so nothing else can read them back.
 */
interface ApiKeyStorageRecord {
    configId: string | undefined;
    storage: "database" | "secondary-storage";
}

// A string, not a module-local `Symbol`: the `plugins` and `worker` entries are bundled
// separately, and the admin plane must find what the plugin factory wrote. Kept apart from
// the wrapper so the admin plane does not pull in `@better-auth/api-key`.
const API_KEY_STORAGE = "lunoraApiKeyStorage";

/**
 * The storage configuration of the installed `api-key` plugin, or `undefined` when none is
 * installed or it was not built by the `@lunora/auth/plugins` wrapper (so its storage is unknown).
 */
const apiKeyStorage = (plugins: ReadonlyArray<{ id: string }> | undefined): ReadonlyArray<ApiKeyStorageRecord> | undefined => {
    const plugin = plugins?.find((candidate) => candidate.id === "api-key") as Record<string, unknown> | undefined;
    const records = plugin?.[API_KEY_STORAGE];

    return Array.isArray(records) ? (records as ApiKeyStorageRecord[]) : undefined;
};

export type { ApiKeyStorageRecord };
export { API_KEY_STORAGE, apiKeyStorage };
