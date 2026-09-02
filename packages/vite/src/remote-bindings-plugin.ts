/**
 * Remote-binding dev for the Vite path (`vite dev`), mirroring `lunora dev`.
 *
 * When remote mode is on (the `--remote`-equivalent `LUNORA_REMOTE` env, or the
 * `remote` key in `lunora.json`), the worker `@cloudflare/vite-plugin` boots
 * should read/write the project's **deployed** D1/KV/R2/Vectorize/Queues/
 * Services/AI instead of empty local resources. We get there exactly like the
 * CLI: materialize a temp wrangler config with `"remote": true` injected on each
 * eligible binding (DO shards stay local) and point the cloudflare plugin's
 * `configPath` at it. All the decision + materialization logic is reused from
 * `@lunora/config` — this module only wires it into the Vite plugin lifecycle.
 *
 * Cleanup runs when Vite's dev server closes (the `buildEnd`/`closeBundle`
 * hooks), so the temp config never leaks past the dev session.
 */
import { readProjectRemotePreference } from "@lunora/config";
import { materializeRemoteWranglerConfig, resolveRemoteEnabled } from "@lunora/config/cloudflare";
import type { Plugin } from "vite";

import { lunoraLine } from "./log";
import type { CloudflarePluginOptions } from "./types";

/** The cloudflare-plugin option Lunora sets to point the worker at our temp config. */
interface RemoteCloudflareOptions {
    configPath?: string;
}

/** The decision a {@link planViteRemoteBindings} call returns. */
interface ViteRemotePlan {
    /** Idempotent disposer for the temp config; always present + safe to call. */
    cleanup: () => void;

    /**
     * Absolute path to the materialized temp wrangler config to hand the
     * cloudflare plugin's `configPath`, or `undefined` when remote mode is off
     * or nothing was materialized (no eligible binding, no wrangler file, …).
     */
    configPath?: string;
    /** Whether remote mode was requested for this dev session. */
    enabled: boolean;
    /** Why remote mode didn't take effect despite being requested, for logging. */
    reason?: string;
}

/** Inputs to the Vite remote-binding decision — injectable so tests don't touch the env/fs. */
interface PlanViteRemoteOptions {
    /** Injection seam — defaults to the real materializer. */
    materialize?: typeof materializeRemoteWranglerConfig;
    /** Project root containing `wrangler.jsonc` + the optional `lunora.json`. */
    projectRoot: string;
    /** Injection seam — defaults to the real `lunora.json` reader. */
    readPreference?: typeof readProjectRemotePreference;
    /** The raw `LUNORA_REMOTE` env value; defaults to `process.env.LUNORA_REMOTE`. */
    remoteEnv?: string;
}

const noopCleanup = (): void => {};

/**
 * Decide whether the Vite dev worker uses remote bindings and, if so,
 * materialize the temp config. Pure decision + a single fs write via the
 * injected materializer; returns a `cleanup` for the dev server's close hook.
 *
 * There is no `--remote` flag on the Vite path (Vite has no Lunora CLI flags),
 * so the precedence reduces to `LUNORA_REMOTE` env > `lunora.json` `remote`.
 */
const planViteRemoteBindings = (options: PlanViteRemoteOptions): ViteRemotePlan => {
    const readPreference = options.readPreference ?? readProjectRemotePreference;
    const enabled = resolveRemoteEnabled({
        configPreference: readPreference(options.projectRoot),
        envValue: options.remoteEnv ?? process.env["LUNORA_REMOTE"],
    });

    if (!enabled) {
        return { cleanup: noopCleanup, enabled: false };
    }

    const materialize = options.materialize ?? materializeRemoteWranglerConfig;
    const result = materialize({ enabled: true, projectRoot: options.projectRoot });

    return {
        // The materializer always returns an idempotent, never-throwing `cleanup`.
        cleanup: result.cleanup,
        configPath: result.configPath,
        enabled: true,
        reason: result.reason,
    };
};

/**
 * Wrap the cloudflare-plugin options so the dev worker loads the materialized
 * remote temp config (via `configPath`) when — and only when — remote mode is
 * on and a temp config was materialized. A `configPath` the caller already set
 * wins (their explicit choice).
 *
 * Pure decision only — the serve-vs-build gate lives in
 * {@link remoteBindingsConfigPlugin}'s `config` hook, because the resolved Vite
 * `command` is unknown at plugin-factory time (when this runs). An eager serve
 * check here would always read `command` as undefined and strip `configPath`.
 */
const withRemoteBindings = (options: CloudflarePluginOptions, plan: ViteRemotePlan): CloudflarePluginOptions => {
    if (!plan.enabled || plan.configPath === undefined) {
        return options;
    }

    const existing = options as RemoteCloudflareOptions;

    // A user-supplied `configPath` is their explicit choice — never override it.
    if (typeof existing.configPath === "string") {
        return options;
    }

    return { ...options, configPath: plan.configPath };
};

/**
 * A `enforce: "pre"` plugin whose `config` hook injects the materialized remote
 * temp config into the cloudflare plugin's `configPath` — but only on a `vite`
 * serve, never a production build (so the deployed worker is never affected).
 *
 * The deferral is the whole point: at plugin-factory time Vite has not yet told
 * us `serve` vs `build`, so the check must run in a `config` hook (where
 * `env.command` is known). It mutates the SAME options object handed to
 * `cloudflare()` in place — the cloudflare plugin reads `pluginConfig.configPath`
 * lazily inside its own `config` hook, which runs after this `enforce: "pre"`
 * one, so the injection takes effect. An eager factory-time serve check (the old
 * behaviour) always saw `command` undefined and silently dropped the path, so
 * remote bindings never activated on `vite dev`.
 *
 * When remote mode was requested but nothing materialized (no eligible binding,
 * no wrangler file, …), the plan's `reason` is logged so the degradation isn't
 * silent.
 *
 * `options` is `undefined` on the BYO path (`cloudflare: false`), where the
 * project constructs `cloudflare()` itself and Lunora has no options object to
 * inject into: the materialized path is printed with what to do with it, rather
 * than leaving `LUNORA_REMOTE` looking like it took effect.
 */
const remoteBindingsConfigPlugin = (options: CloudflarePluginOptions | undefined, plan: ViteRemotePlan): Plugin => {
    return {
        config(_userConfig, env) {
            if (env.command !== "serve") {
                return;
            }

            if (options === undefined) {
                if (plan.enabled && plan.configPath !== undefined) {
                    // eslint-disable-next-line no-console -- surface the degradation; the dev server's logger isn't available in the `config` hook.
                    console.info(
                        lunoraLine(
                            `remote bindings are materialized at ${plan.configPath} — this project adds @cloudflare/vite-plugin itself (\`cloudflare: false\`), so pass that path as its \`configPath\` to use them.`,
                        ),
                    );
                }

                return;
            }

            const merged = withRemoteBindings(options, plan) as RemoteCloudflareOptions;
            const target = options as RemoteCloudflareOptions;

            if (merged.configPath !== undefined && target.configPath === undefined) {
                target.configPath = merged.configPath;
            } else if (plan.enabled && plan.configPath === undefined && plan.reason !== undefined) {
                // eslint-disable-next-line no-console -- surface the silent degradation; the dev server's logger isn't available in the `config` hook.
                console.info(lunoraLine(`remote bindings requested but not applied: ${plan.reason}`));
            }
        },
        enforce: "pre",
        name: "lunora:remote-bindings-config",
    };
};

/**
 * A tiny Vite plugin that runs the remote temp-config disposer when the dev
 * server tears down (`buildEnd` fires on close in serve; `closeBundle` covers
 * the build/close path). Idempotent cleanup means firing on both is safe.
 */
const remoteBindingsCleanupPlugin = (cleanup: () => void): Plugin => {
    return {
        buildEnd() {
            cleanup();
        },
        closeBundle() {
            cleanup();
        },
        enforce: "pre",
        name: "lunora:remote-bindings-cleanup",
    };
};

export type { PlanViteRemoteOptions, ViteRemotePlan };
export { planViteRemoteBindings, remoteBindingsCleanupPlugin, remoteBindingsConfigPlugin, withRemoteBindings };
