import { lunoraLine } from "@lunora/config";
import { warnCloudflareCliConfigOnce } from "@lunora/config/cloudflare";
import type { Plugin } from "vite";

import type { ResolvedLunoraPluginOptions } from "./types";

/**
 * Warn once per process tree when the project also has a Cloudflare CLI config
 * (`cloudflare.config.{ts,mts,js,mjs}`): Lunora manages the wrangler config and
 * never updates that file, so `cf dev` / `cf build` / `cf deploy` would run from
 * a stale one (https://github.com/anolilab/lunora/issues/964).
 *
 * Registered unconditionally — this is not a wrangler *check*, so
 * `validateWrangler: false` does not silence it — and with no `apply`: warning
 * during `vite build` is intended, since a build is exactly where someone reaches
 * for `cf deploy` next. A config reload re-runs `configResolved`, and `lunora dev`
 * claims the warning before spawning Vite; the process-tree guard keeps both quiet.
 */
const cloudflareCliConfigPlugin = (options: ResolvedLunoraPluginOptions): Plugin => {
    return {
        configResolved(config) {
            warnCloudflareCliConfigOnce(options.projectRoot, (message) => {
                config.logger.warn(lunoraLine(message));
            });
        },
        name: "lunora:cf-config-warning",
    };
};

export default cloudflareCliConfigPlugin;
