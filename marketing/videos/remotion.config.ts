/**
 * Note: When using the Node.JS APIs, the config file does not apply. Instead,
 * pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import path from "node:path";

import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";

// Remotion loads this config as CJS, so `import.meta` is empty here. The CLI
// runs from the package root, so resolve `src` from the working directory.
const srcDir = path.resolve(process.cwd(), "src");

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.overrideWebpackConfig((config) => {
    const withTailwind = enableTailwind(config);

    // The components.json `@/*` alias (tsconfig paths) isn't read by Remotion's
    // webpack, so mirror it here for the remocn imports + our own scene imports.
    return {
        ...withTailwind,
        resolve: {
            ...withTailwind.resolve,
            alias: {
                ...withTailwind.resolve?.alias,
                "@": srcDir,
            },
        },
    };
});
