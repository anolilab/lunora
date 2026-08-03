import { createAuthClient } from "better-auth/react";

/**
 * Browser half of `lunora/auth.ts`. No plugins, so no plugin client list —
 * see `examples/auth-playground` for the org/admin/2FA client wiring.
 *
 * The type is widened because better-auth's inferred client type reaches into
 * nested zod internals that this package does not declare. The runtime shape is
 * unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const authClient: any = createAuthClient({
    baseURL: (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin,
});
