/**
 * Remote-binding dev for the Vite path (`vite dev`), mirroring `cirrus dev`.
 *
 * When remote mode is on (the `--remote`-equivalent `CIRRUS_REMOTE` env, or the
 * `remote` key in `cirrus.json`), the worker `@cloudflare/vite-plugin` boots
 * should read/write the project's **deployed** D1/KV/R2/Vectorize/Queues/
 * Services/AI instead of empty local resources. We get there exactly like the
 * CLI: materialize a temp wrangler config with `"remote": true` injected on each
 * eligible binding (DO shards stay local) and point the cloudflare plugin's
 * `configPath` at it. All the decision + materialization logic is reused from
 * `@cirrus/config` — this module only wires it into the Vite plugin lifecycle.
 *
 * Cleanup runs when Vite's dev server closes (the `buildEnd`/`closeBundle`
 * hooks), so the temp config never leaks past the dev session.
 */
import { materializeRemoteWranglerConfig, readProjectRemotePreference, resolveRemoteEnabled } from "@cirrus/config";
import type { Plugin } from "vite";

import type { CloudflarePluginOptions } from "./types";

/** The cloudflare-plugin option Cirrus sets to point the worker at our temp config. */
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
    /** Project root containing `wrangler.jsonc` + the optional `cirrus.json`. */
    projectRoot: string;
    /** Injection seam — defaults to the real `cirrus.json` reader. */
    readPreference?: typeof readProjectRemotePreference;
    /** The raw `CIRRUS_REMOTE` env value; defaults to `process.env.CIRRUS_REMOTE`. */
    remoteEnv?: string;
}

const noopCleanup = (): void => {};

/**
 * Decide whether the Vite dev worker uses remote bindings and, if so,
 * materialize the temp config. Pure decision + a single fs write via the
 * injected materializer; returns a `cleanup` for the dev server's close hook.
 *
 * There is no `--remote` flag on the Vite path (Vite has no Cirrus CLI flags),
 * so the precedence reduces to `CIRRUS_REMOTE` env > `cirrus.json` `remote`.
 */
const planViteRemoteBindings = (options: PlanViteRemoteOptions): ViteRemotePlan => {
    const readPreference = options.readPreference ?? readProjectRemotePreference;
    const enabled = resolveRemoteEnabled({
        configPreference: readPreference(options.projectRoot),
        envValue: options.remoteEnv ?? process.env["CIRRUS_REMOTE"],
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
 * on AND it's a `vite` serve. A `configPath` the caller already set wins (their
 * explicit choice), and during a production build nothing is injected, so the
 * deployed worker is never affected.
 *
 * Returns the wrapped options plus the plan, so `index.ts` can register the
 * cleanup on a close hook. Materialization happens lazily inside the `configPath`
 * resolution path: it's only meaningful during serve, but computing it eagerly
 * is harmless (the materializer is a no-op when disabled) and keeps the wiring
 * simple — the plan is computed once here.
 */
const withRemoteBindings = (options: CloudflarePluginOptions, isServe: () => boolean, plan: ViteRemotePlan): CloudflarePluginOptions => {
    if (!plan.enabled || plan.configPath === undefined) {
        return options;
    }

    const existing = options as RemoteCloudflareOptions;

    // A user-supplied `configPath` is their explicit choice — never override it.
    if (typeof existing.configPath === "string") {
        return options;
    }

    if (!isServe()) {
        return options;
    }

    return { ...options, configPath: plan.configPath };
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
        name: "cirrus:remote-bindings-cleanup",
    };
};

export type { PlanViteRemoteOptions, ViteRemotePlan };
export { planViteRemoteBindings, remoteBindingsCleanupPlugin, withRemoteBindings };
