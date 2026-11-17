import { adminClient, lunoraSessionSync } from "@lunora/auth/plugins/client";
import { createAuthClient } from "better-auth/react";

/**
 * The browser's better-auth client, for the two things the kit does through
 * better-auth rather than through a Lunora function: the admin's user table
 * (`admin.listUsers`, `banUser`, `impersonateUser`, …) and reading whether the
 * current session is an impersonation.
 *
 * `lunoraSessionSync` tells the Lunora client when the session changes, so its
 * socket re-authenticates as whoever the session now belongs to.
 *
 * `lunora add auth-ui` writes a fuller client to `lunora/auth-ui/client.ts`;
 * once you have it, enable its `admin` plugin toggle and import that one here
 * instead, so the app has a single client.
 */
export const authClient = createAuthClient({ plugins: [lunoraSessionSync(), adminClient()] });
