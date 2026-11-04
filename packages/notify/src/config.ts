import type { FcmConfig } from "@visulima/notification/providers/fcm";
import type { WebPushConfig } from "@visulima/notification/providers/web-push";

import { fcmServiceAccountTokenSource, parseServiceAccount } from "./fcm-service-account";
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
    serviceAccount: "FCM_SERVICE_ACCOUNT",
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
 * Stands in for the project id of a key that cannot be parsed. `createFcmProvider` throws on a
 * missing id, which would fail every channel of the engine; this one is never sent, because the
 * provider asks for a token before it builds a request and the token source rejects with the
 * parse error. FCM sends then report the bad key instead of a missing `fcm` channel.
 */
const MALFORMED_KEY_PROJECT_ID = "unresolved-malformed-service-account";

/** The key file's own project id, or the placeholder above when the key cannot be parsed. */
const projectIdOf = (rawServiceAccount: string): string | undefined => {
    try {
        return parseServiceAccount(rawServiceAccount).project_id;
    } catch {
        return MALFORMED_KEY_PROJECT_ID;
    }
};

/**
 * Resolve an {@link FcmConfig} from the Worker `env`.
 *
 * Production: `FCM_SERVICE_ACCOUNT` holds the Google service-account key file, as JSON or
 * base64 of it. The access token is minted from it on demand and cached until shortly
 * before it expires, so `defineNotify({ fcm: (env) => fcmFromEnv(env) })` is correct as written.
 * `FCM_PROJECT_ID` overrides the project id in the key file.
 *
 * Dev: a static `FCM_ACCESS_TOKEN` is accepted when no service account is set. It
 * expires within the hour, so it is only a stopgap for local work.
 *
 * Returns `undefined` when no project id can be resolved. A malformed key does not throw
 * here: the token source rejects with the parse error instead, so only FCM sends fail, not
 * the other channels that share this engine.
 */
const fcmFromEnv = (env: NotifyEnv, overrides?: Partial<FcmConfig>): FcmConfig | undefined => {
    const envProjectId = readString(env, FCM_ENV_KEYS.projectId); // secret-scanner:allow -- `projectId` is a config field name, not a credential
    const rawServiceAccount = readString(env, FCM_ENV_KEYS.serviceAccount);
    const projectId = overrides?.projectId ?? envProjectId ?? (rawServiceAccount === undefined ? undefined : projectIdOf(rawServiceAccount));

    if (projectId === undefined) {
        return undefined;
    }

    if (rawServiceAccount !== undefined) {
        return { getAccessToken: fcmServiceAccountTokenSource(rawServiceAccount), projectId, ...overrides };
    }

    return { accessToken: readString(env, FCM_ENV_KEYS.accessToken), projectId, ...overrides };
};

export { FCM_ENV_KEYS, fcmFromEnv, WEB_PUSH_ENV_KEYS, webPushFromEnv };
