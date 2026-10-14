import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags an app that sends push notifications (`ctx.push.send` / `ctx.push.broadcast`)
 * but whose `defineNotify(...)` wires **neither** the Web Push nor the FCM channel.
 *
 * With no push channel configured, every `ctx.push` send fails at runtime (the
 * routing push provider has nothing to dispatch to) — a silent, deploy-time-only
 * misconfiguration. Web Push additionally needs the `VAPID_*` secrets and FCM the
 * `FCM_*` secrets; those are scaffolded into `.dev.vars` from `@lunora/config`'s
 * package-secrets registry, but the channel must still be wired in `defineNotify`.
 *
 * This lint runs when the codegen feeder has supplied config evidence
 * (`context.notifyConfig` present); a runtime caller with no evidence flags
 * nothing.
 */
const notifyMissingPushConfig: Lint = {
    categories: ["SCHEMA"],
    description:
        "The app sends push notifications via `ctx.push` but `defineNotify(...)` configures neither a Web Push nor an FCM channel, so every send fails at runtime. Wire at least one push channel (`webPush` and/or `fcm`) and provide its secrets (`VAPID_*` / `FCM_*`).",
    facing: "INTERNAL",
    level: "WARN",
    name: "notify_missing_push_config",
    remediation:
        "In `lunora/notify.ts`, wire a push channel: `defineNotify({ webPush: (env) => webPushFromEnv(env) })` and set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` in `.dev.vars` (or configure `fcm` with `FCM_PROJECT_ID`). Generate a VAPID keypair with `npx web-push generate-vapid-keys`.",
    run: (context) => {
        const config = context.notifyConfig;

        // No config evidence, or the app doesn't push, or a channel is wired → nothing to assert.
        if (config === undefined || !config.usesPush || config.hasWebPush || config.hasFcm) {
            return [];
        }

        return [
            emit(notifyMissingPushConfig, {
                cacheKey: "notify_missing_push_config",
                detail: "`ctx.push` is used to send notifications, but `defineNotify(...)` wires neither `webPush` nor `fcm` — every push send will fail at runtime. Configure at least one push channel and its secrets.",
                metadata: { hasFcm: config.hasFcm, hasWebPush: config.hasWebPush, usesPush: config.usesPush },
            }),
        ];
    },
    source: "static",
    title: "Push used with no Web Push / FCM channel configured",
};

export default notifyMissingPushConfig;
