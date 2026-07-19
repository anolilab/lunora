import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

import packageJson from "./package.json" with { type: "json" };

// The Nuxt module metadata @nuxt/module-builder used to emit. `configKey` mirrors
// `meta.configKey` in src/module.ts and is what maps `nuxt.config`'s `lunora` key to this module.
const MODULE_JSON = { configKey: "lunora", name: packageJson.name, version: packageJson.version };

const esmEntry = (input: string) => ({ cjs: false, declarationCjs: false, declarationEsm: true, esm: true, input });

// @lunora/nuxt is a Nuxt module: the `module`/`server` entries are bundled, but the
// `runtime/` files must ship file-to-file (Nuxt/Nitro re-includes them into the consuming
// app at their own paths). Declaring each runtime file as its OWN entry makes rollup keep
// them as separate outputs with their sibling `./x` imports preserved — the file-to-file
// shape @nuxt/module-builder produced via mkdist, but on packem/oxc (TS7-native, no pin).
//
// The runtime set is discovered from disk (not hand-listed) so adding a `src/runtime/*.ts`
// can't silently drop it from the build — which would then fail to resolve in the consuming app.
const runtimeEntries = readdirSync("src/runtime", { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
    .map((entry) => esmEntry(`src/runtime/${entry.split("\\").join("/")}`));

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    failOnWarn: false,
    emitCJS: false,
    emitESM: true,
    declaration: true,
    entries: [esmEntry("src/module.ts"), esmEntry("src/server.ts"), ...runtimeEntries],
    rollup: {
        dts: {
            oxc: true,
        },
    },
    hooks: {
        "build:done": (context): void => {
            writeFileSync(join(context.options.rootDir, "dist", "module.json"), `${JSON.stringify(MODULE_JSON, null, 2)}\n`);
        },
    },
    transformer,
}) as BuildConfig;
