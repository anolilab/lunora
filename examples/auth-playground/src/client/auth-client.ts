import { adminClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser-side counterpart to the server's `createAuth(...)` call. Each plugin
 * loaded on the server must have its matching `*Client` here so the client SDK
 * surfaces the matching endpoint helpers (`authClient.organization.*`,
 * `authClient.admin.*`).
 *
 * The base URL is the same origin Vite + the Cloudflare Worker share — see
 * `main.tsx` for how the env override is wired.
 *
 * The exported type is widened to `any` because better-auth's inferred client
 * type pulls in deeply-nested zod / access-control internals that aren't
 * declared in this package's `dependencies` and can't be exported portably.
 * The runtime shape is unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authClient: any = createAuthClient({
    baseURL: (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin,
    plugins: [organizationClient(), adminClient()],
});
