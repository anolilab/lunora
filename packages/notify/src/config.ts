import type { FcmConfig } from "@visulima/notification/providers/fcm";
import type { WebPushConfig } from "@visulima/notification/providers/web-push";

import type { NotifyEnv } from "./types";

/**
 * `.dev.vars` / Worker `env` keys the built-in config resolvers read. Mirrored in
 * `@lunora/config`'s package-secrets registry so `lunora dev` scaffolds them into
 * `.dev.vars.example`.
 */
const WEB_PUSH_ENV_KEYS = {
    privateKey: "VAPID_PRIVATE_KEY",
    publicKey: "VAPID_PUBLIC_KEY",
    subject: "VAPID_SUBJECT",
} as const;

const FCM_ENV_KEYS = {
    accessToken: "FCM_ACCESS_TOKEN",
    projectId: "FCM_PROJECT_ID",
} as const;

const readString = (env: NotifyEnv, key: string): string | undefined => {
    const value = env[key];

    return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * Resolve a {@link WebPushConfig} from the Worker `env` VAPID secrets
 * (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). Returns `undefined`
 * when any is missing, leaving the Web Push channel unwired rather than throwing —
 * so an app can ship FCM-only (or vice versa) without failing ctx construction.
 *
 * Generate a VAPID keypair once with `npx web-push generate-vapid-keys` (or any
 * P-256 tool) and set `VAPID_SUBJECT` to a `mailto:` or `https:` contact.
 */
const webPushFromEnv = (env: NotifyEnv, overrides?: Partial<WebPushConfig>): WebPushConfig | undefined => {
    const vapidPublicKey = readString(env, WEB_PUSH_ENV_KEYS.publicKey);
    const vapidPrivateKey = readString(env, WEB_PUSH_ENV_KEYS.privateKey);
    const vapidSubject = readString(env, WEB_PUSH_ENV_KEYS.subject);

    if (vapidPublicKey === undefined || vapidPrivateKey === undefined || vapidSubject === undefined) {
        return undefined;
    }

    return { vapidPrivateKey, vapidPublicKey, vapidSubject, ...overrides };
};

/**
 * Resolve an {@link FcmConfig} from the Worker `env` (`FCM_PROJECT_ID` plus a
 * static `FCM_ACCESS_TOKEN`). Returns `undefined` when the project id is missing.
 *
 * The static token is convenient for local dev but expires; in production prefer
 * passing your own `getAccessToken` (e.g. wrapping `google-auth-library`) via
 * `defineNotify({ fcm: (env) => ({ ...fcmFromEnv(env), getAccessToken }) })` —
 * that keeps the provider edge-safe (no Google SDK / `node:crypto` bundled).
 */
const fcmFromEnv = (env: NotifyEnv, overrides?: Partial<FcmConfig>): FcmConfig | undefined => {
    const projectId = readString(env, FCM_ENV_KEYS.projectId);

    if (projectId === undefined) {
        return undefined;
    }

    const accessToken = readString(env, FCM_ENV_KEYS.accessToken);

    return { accessToken, projectId, ...overrides };
};

export { FCM_ENV_KEYS, fcmFromEnv, WEB_PUSH_ENV_KEYS, webPushFromEnv };
