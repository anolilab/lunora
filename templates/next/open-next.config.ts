import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Default OpenNext Cloudflare config: no incremental cache, no queue — the
// Lunora backend (the realtime plane) lives in its own worker, so the Next
// worker stays a plain SSR deployment. Add R2/KV caching here later if needed:
// https://opennext.js.org/cloudflare
export default defineCloudflareConfig();
