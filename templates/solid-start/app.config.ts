import { cirrus } from "@cirrus/vite";
import { defineConfig } from "@solidjs/start/config";

/**
 * SolidStart app config. The Cirrus Vite plugin (codegen + wrangler validation +
 * the dev error overlay) stacks alongside SolidStart's own Vite pipeline via the
 * `vite.plugins` hook, so a single `vinxi`/Vite build emits one worker.
 *
 * SolidStart is a class-A integration (PLAN4 §3): we own the worker entry
 * (`src/server.ts`), which composes the SolidStart SSR handler into
 * `createWorker({ httpRouter })`. Cirrus realtime mounts under `/_cirrus/*`; the
 * SolidStart handler serves everything else.
 */
export default defineConfig({
    server: {
        // Emit a Cloudflare module worker so the SolidStart handler can be
        // composed into the Cirrus worker entry.
        preset: "cloudflare-module",
    },
    vite: {
        plugins: [cirrus()],
    },
});
