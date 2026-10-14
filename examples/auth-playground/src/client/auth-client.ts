import { lunoraAuthPlugins } from "@lunora/auth/plugins/client";
import { createAuthClient } from "better-auth/react";

/**
 * Browser-side counterpart to the server's `createAuth(...)` call. Instead of
 * hand-listing every `*Client()` plugin, `lunoraAuthPlugins` assembles the
 * standard array from feature toggles — keep these in parity with the server
 * `plugins` passed to `createAuth`.
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
    plugins: lunoraAuthPlugins({ admin: true, organization: true, twoFactor: true }),
});
