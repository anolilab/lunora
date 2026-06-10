import type { Config } from "@react-router/dev/config";

/**
 * React Router v7 framework config. `ssr: true` is the default and is what makes
 * loaders run on the server (in the Cloudflare Worker) — the prerequisite for
 * Cirrus's live loaders. `appDirectory` mirrors the template layout.
 */
export default {
    appDirectory: "app",
    ssr: true,
} satisfies Config;
