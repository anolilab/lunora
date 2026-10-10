/**
 * Keep `vite dev` booting when the `ai` binding can't be reached.
 *
 * Importing `@lunora/ai` makes `bindingsProvisionPlugin` write `"ai"` into
 * `wrangler.jsonc`, and Workers AI has no local emulation, so
 * `@cloudflare/vite-plugin` opens a remote proxy session for it at boot. With no
 * Cloudflare login that session fails and the dev server dies, even for an app
 * whose models come from `LUNORA_AI_PROXY_URL` or an AI SDK provider. Here the
 * binding is dropped from each worker config in memory instead, through the
 * plugin's `config` customizers: no temp file, so nothing is left behind when the
 * dev server is killed. The rule itself lives in `dev-config.ts`.
 *
 * Every Worker counts: the entry Worker, and each `auxiliaryWorkers` entry, which
 * the Cloudflare plugin resolves with its own customizer. `serviceWorkersPlugin`
 * adds the `lunora.config` services as auxiliary entries, so this runs after it.
 *
 * Dev only. The customizers also run on `vite build`, whose output is the deploy
 * config, so the plugin below records the command first.
 */
import { lunoraLine } from "@lunora/config";
import { describeWithheldWorkersAi, hasCloudflareCredentials, withheldWorkersAi } from "@lunora/config/cloudflare";
import type { Plugin } from "vite";

import type { CloudflarePluginOptions } from "./types";

/** The slice of a resolved worker config this module reads and edits. */
interface WorkerConfigLike {
    ai?: { binding?: string } | null;
}

type Customizer = (config: WorkerConfigLike, ...rest: unknown[]) => Partial<WorkerConfigLike> | undefined;

interface LocalAiOptions {
    /** Injection seam; defaults to a credential probe of {@link LocalAiOptions.projectRoot}. */
    hasCredentials?: () => boolean;
    /** Project whose `.env` files the credential probe also reads. */
    projectRoot?: string;
}

/** Customizers this module already wrapped, so a second `config` pass doesn't nest them. */
const wrapped = new WeakSet<object>();

/**
 * Wrap `options.config` and every `auxiliaryWorkers` entry so a dev worker without
 * Cloudflare credentials gets no `ai` binding, and return the `enforce: "pre"`
 * plugin that tells the wrapper a dev server (not a build) is running. A user
 * customizer still runs first; an `ai` it returns is dropped too, since its result
 * is merged over the config.
 *
 * The Cloudflare plugin rejects a `config` customizer together with
 * `experimental.newConfig`, so in that mode nothing is wrapped and the binding
 * stays, as it did before this helper existed.
 */
const localAiBinding = (options: CloudflarePluginOptions, localOptions: LocalAiOptions = {}): Plugin => {
    let serving = false;
    const newConfig = (options as { experimental?: { newConfig?: unknown } }).experimental?.newConfig;
    // `false` is the legacy path, which still accepts a config customizer.
    const usesNewConfig = newConfig !== undefined && newConfig !== false;
    const hasCredentials = localOptions.hasCredentials ?? (() => hasCloudflareCredentials({ projectRoot: localOptions.projectRoot }));

    const wrapCustomizer = (userConfig: unknown): Customizer => {
        const wrap: Customizer = (config, ...rest) => {
            const fromUser =
                typeof userConfig === "function" ? (userConfig as Customizer)(config, ...rest) : (userConfig as Partial<WorkerConfigLike> | undefined);
            // A copy: a plain-object customizer is the user's own object, and the
            // delete below must not stick to it for the rest of the process.
            const result = fromUser === undefined ? undefined : { ...fromUser };
            const withheld = serving ? withheldWorkersAi(config.ai ?? result?.ai, hasCredentials) : undefined;

            if (withheld !== undefined) {
                // In place by design: the plugin merges the returned object with `defu`,
                // which keeps any key the base config still has.
                // eslint-disable-next-line no-param-reassign
                delete config.ai;
                delete result?.ai;
                // eslint-disable-next-line no-console -- the dev server's logger isn't available while the Cloudflare plugin resolves its config.
                console.warn(lunoraLine(describeWithheldWorkersAi(withheld)));
            }

            return result;
        };

        wrapped.add(wrap);

        return wrap;
    };

    return {
        config(_userConfig, env) {
            serving = env.command === "serve" && env.isPreview !== true;

            if (usesNewConfig) {
                return;
            }

            const target = options as { auxiliaryWorkers?: unknown; config?: unknown };

            if (!wrapped.has(target.config as object)) {
                target.config = wrapCustomizer(target.config);
            }

            if (Array.isArray(target.auxiliaryWorkers)) {
                target.auxiliaryWorkers = target.auxiliaryWorkers.map((entry: { config?: unknown }) =>
                    wrapped.has(entry.config as object) ? entry : { ...entry, config: wrapCustomizer(entry.config) },
                );
            }
        },
        enforce: "pre",
        name: "lunora:local-ai-binding",
    };
};

export default localAiBinding;
