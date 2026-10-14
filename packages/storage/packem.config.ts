import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    // `aws4fetch` is never imported here — it is an OPTIONAL peer of
    // `@visulima/storage`, and `createR2UploadStorage` constructs its
    // `AwsLightStorage` provider, which imports it. Declaring it in our
    // `dependencies` is what makes that provider resolve for a consumer, so the
    // "listed but not used" reading is wrong: dropping it breaks R2 uploads at
    // runtime rather than trimming a dead dependency.
    validation: {
        dependencies: {
            hoisted: { exclude: [] },
            unused: { exclude: ["aws4fetch"] },
        },
    },
    rollup: {
        dts: {
            oxc: true,
        },
        license: {
            path: "./LICENSE.md",
        },
    },
    transformer,
}) as BuildConfig;
