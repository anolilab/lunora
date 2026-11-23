import { apiKey as betterAuthApiKey } from "@better-auth/api-key";

import type { ApiKeyStorageRecord } from "./api-key-storage";
import { API_KEY_STORAGE } from "./api-key-storage";

type ApiKeyInput = Parameters<typeof betterAuthApiKey>[0];

const storageRecords = (input: ApiKeyInput): ApiKeyStorageRecord[] =>
    (Array.isArray(input) ? input : [input]).map((config) => {
        return { configId: config?.configId, storage: config?.storage ?? "database" };
    });

/**
 * The better-auth `apiKey()` plugin, with its storage configuration recorded on the plugin
 * so `createAuthAdmin().deleteApiKey` can tell a key it can fully revoke from one the
 * plugin also holds in secondary or custom storage.
 */
const apiKey = (...parameters: Parameters<typeof betterAuthApiKey>): ReturnType<typeof betterAuthApiKey> =>
    Object.assign(betterAuthApiKey(...parameters), { [API_KEY_STORAGE]: storageRecords(parameters[0]) });

export default apiKey;
