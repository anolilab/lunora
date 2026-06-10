import { cirrus } from "@cirrus/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * The React Router v7 (framework mode) app + Cirrus's vite plugin share a single
 * config. `reactRouter()` builds the SSR routes; `cirrus()` runs codegen +
 * wrangler validation + the dev overlay, detects the framework (React Router →
 * class A), and reconciles the Cloudflare bindings into `wrangler.jsonc`. The
 * single worker entry (`workers/app.ts`) composes both into one Cloudflare
 * Worker via `createWorker({ httpRouter })`.
 */
export default defineConfig({
    plugins: [reactRouter(), cirrus(), tsconfigPaths()],
});
