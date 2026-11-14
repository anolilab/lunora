/// <reference types="@cloudflare/vitest-plugin/types" />

import type { D1Database } from "@cloudflare/workers-types";

/** The bindings the test reads through `cloudflare:test`'s `env`; the rest of the Worker's bindings are reached through the app. */
declare global {
    namespace Cloudflare {
        interface Env {
            AUTH_SECRET: string;
            DB: D1Database;
        }
    }
}
