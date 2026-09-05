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
 * Materialization and cleanup both live in the plugin lifecycle: the temp config
 * is written from the `config` hook — after Lunora has provisioned the bindings
 * the project's code implies — and disposed when Vite's dev server closes (the
 * `buildEnd`/`closeBundle` hooks), so it never leaks past the dev session.
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
 *
 * Call this from a `config` hook, never at plugin-factory time — see
 * {@link remoteBindingsPlugin} for the two defects that timing caused.
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
 * {@link remoteBindingsPlugin}'s `config` hook, because the resolved Vite
 * `command` is unknown at plugin-factory time. An eager serve check there would
 * always read `command` as undefined and strip `configPath`.
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
 * A `enforce: "pre"` plugin that materializes the remote temp wrangler config
 * and injects it into the cloudflare plugin's `configPath` — but only on a
 * `vite` serve, never a production build (so the deployed worker is never
 * affected) — then disposes the temp file when the dev server tears down.
 *
 * Both halves are deferred into the `config` hook, and each deferral closes a
 * defect of its own.
 *
 * The command check: at plugin-factory time Vite has not yet resolved `serve`
 * vs `build`, so it has to run here. An eager factory-time check always read
 * `command` as undefined and stripped `configPath`, so remote bindings never
 * activated on `vite dev` at all.
 *
 * The materialization: the temp config is a COPY of `wrangler.jsonc`, and
 * Lunora provisions the bindings the project's code implies from
 * `bindingsProvisionPlugin`'s own `config` hook — earlier in this same phase,
 * since both are `enforce: "pre"` and that plugin is registered first. (It is a
 * plugin of its own, registered unconditionally, precisely so this copy is not a
 * binding short whenever `validateWrangler` is off — `wranglerValidatorPlugin`
 * only validates, and is registered after this one.) Copying
 * the file at factory time therefore snapshotted it BEFORE that write, and the
 * dev worker booted against a config missing the binding Lunora had just added:
 * a `vite dev` that logged `inferred bindings → AI (Workers AI)`, passed
 * validation, and served a worker with no `env.AI`. That is the remote twin of
 * the local defect the reconcile's move into `config` fixed.
 *
 * The injection mutates the SAME options object handed to `cloudflare()` in
 * place — the cloudflare plugin reads `pluginConfig.configPath` lazily inside
 * its own `config` hook, which runs after this `enforce: "pre"` one, so the
 * injection takes effect.
 *
 * The disposer reads the CURRENT plan rather than a factory-time capture,
 * because no plan exists until `config` has run.
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
const remoteBindingsPlugin = (options: CloudflarePluginOptions | undefined, planOptions: PlanViteRemoteOptions): Plugin => {
    let plan: ViteRemotePlan = { cleanup: noopCleanup, enabled: false };
    /** The path THIS plugin injected, so a re-entrant `config` can tell it from a user-supplied one. */
    let injected: string | undefined;

    const dispose = (): void => {
        plan.cleanup();
    };

    return {
        buildEnd: dispose,
        closeBundle: dispose,
        config(_userConfig, env) {
            if (env.command !== "serve") {
                return;
            }

            // A no-op before the first materialization; it only bites when Vite
            // re-runs `config` on the same plugin instance, where replacing the
            // plan without disposing would orphan the previous temp file.
            plan.cleanup();
            plan = planViteRemoteBindings(planOptions);

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

            const target = options as RemoteCloudflareOptions;

            // Forget our OWN injection from a previous `config` pass before
            // deciding. `withRemoteBindings` treats any `configPath` already on the
            // options as the user's explicit choice and leaves it alone — but on a
            // re-entrant pass the one it finds is the temp file `plan.cleanup()`
            // just unlinked, so the cloudflare plugin was pointed at a deleted path.
            if (injected !== undefined && target.configPath === injected) {
                delete target.configPath;
            }

            const merged = withRemoteBindings(options, plan) as RemoteCloudflareOptions;

            if (merged.configPath !== undefined && target.configPath === undefined) {
                target.configPath = merged.configPath;
                injected = merged.configPath;
            } else if (plan.enabled && plan.configPath === undefined && plan.reason !== undefined) {
                // eslint-disable-next-line no-console -- surface the silent degradation; the dev server's logger isn't available in the `config` hook.
                console.info(lunoraLine(`remote bindings requested but not applied: ${plan.reason}`));
            }
        },
        enforce: "pre",
        name: "lunora:remote-bindings",
    };
};

export type { PlanViteRemoteOptions, ViteRemotePlan };
export { planViteRemoteBindings, remoteBindingsPlugin, withRemoteBindings };
