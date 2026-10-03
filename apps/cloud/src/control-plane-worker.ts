/**
 * The control plane's Lunora worker — `createWorker` over this app's functions,
 * crons, auth and HTTP router — built once per isolate. The Worker entry
 * (`src/server.ts`) serves requests and crons through it; the build runner
 * (`src/builds/runner-do.ts`) calls its own routes through it in-process, which
 * is how a Durable Object alarm gets the request-scoped Lunora context the
 * build's mutations run on.
 */
import { createAuthAdmin, handleAuthRequest } from "@lunora/auth";
import type { D1DatabaseLike } from "@lunora/d1";
import { facetGlobalColumn, listGlobalTables, readGlobalTablePage } from "@lunora/d1";
import type { GlobalIntrospector, LunoraWorker } from "@lunora/runtime";
import { createWorker } from "@lunora/runtime";
// TanStack Start's server entry default-exports a `{ fetch }` handler — the same
// expression `@lunora/vite`'s class-A composition table emits for this framework.
import ssrHandler from "@tanstack/react-start/server-entry";

import { LUNORA_CRONS } from "../lunora/_generated/crons.js";
import { LUNORA_FUNCTIONS } from "../lunora/_generated/functions.js";
import { openApiSpec } from "../lunora/_generated/openapi.js";
import schema from "../lunora/schema.js";
import { currentAuth } from "./auth";
import type { ControlPlaneEnv } from "./control-plane-env";
import { buildExec } from "./d1-store";
import { createDeployRouter } from "./deploy/router";

/** Let the studio's global data browser list/page the `.global()` (D1) tables. */
const d1Introspector = (database: D1DatabaseLike): GlobalIntrospector => {
    const exec = buildExec(database);

    return {
        facetColumn: (options) => facetGlobalColumn(exec, schema as never, options),
        listTables: () => listGlobalTables(exec, schema as never),
        readTablePage: (options) => readGlobalTablePage(exec, schema as never, options),
    };
};

let worker: LunoraWorker | null = null;
// The deploy API (`POST /v1/deploy`), mounted as the lowest-priority matcher.
// Created once so its deploy pacer persists across requests.
const deployRouter = createDeployRouter();

/**
 * The `httpRouter` seam, shared by two consumers.
 *
 * `createWorker` treats `httpRouter` as its LOWEST-priority matcher — it runs only
 * after auth (`/api/auth/*`), the explicit routes, and the reserved `/_lunora/*`
 * endpoints have all declined. That is what makes this composition safe: the
 * studio's SSR loaders reach Lunora over `POST /_lunora/rpc` and better-auth over
 * `/api/auth/get-session`, both of which are dispatched ahead of here, so a render
 * can never recurse into itself.
 *
 * `/v1/*` is the machine-facing deploy/telemetry API and keeps its own router —
 * which 404s anything outside `/v1/`, so it cannot be the fallback. Everything
 * else is a browser navigation and belongs to the TanStack Start SSR handler.
 * Ordering, not overlap: the two never contend for a path.
 */
const httpRouter = {
    fetch: async (request: Request, environment?: unknown): Promise<Response> => {
        if (new URL(request.url).pathname.startsWith("/v1/")) {
            return deployRouter.fetch(request, environment);
        }

        // Only the request: TanStack Start's `fetch` takes its OWN options object
        // second (`{ context, onEarlyHints, … }`), not the Cloudflare env. The
        // loaders reach Lunora and better-auth over HTTP, so they need no bindings.
        return ssrHandler.fetch(request);
    },
};

const buildWorker = (env: ControlPlaneEnv): LunoraWorker => {
    // Non-null by construction: every caller awaits `ensureAuth` first — the
    // Worker's `fetch`, and the build runner's alarm — and `scheduled` reaches
    // it only after a request has.
    const auth = currentAuth();

    return createWorker({
        adminToken: env.LUNORA_ADMIN_TOKEN,
        // Dispatch better-auth's `/api/auth/*` routes inside the worker so the
        // studio and the control plane share an origin.
        authAdmin: auth ? createAuthAdmin(auth) : undefined,
        authHandler: (request) => (auth ? handleAuthRequest(auth, request) : Promise.resolve(undefined)),
        // Code-first crons (lunora/crons.ts): the cleanup-expired-previews job
        // fires on the worker's `scheduled()` entry. The control plane is an
        // account-level worker, so its cron triggers fire normally (§2.4).
        cronJobs: LUNORA_CRONS,
        functions: LUNORA_FUNCTIONS,
        globalIntrospector: env.DB ? d1Introspector(env.DB as D1DatabaseLike) : undefined,
        httpRouter,
        openApiSpec,
        resolveIdentity: async (request) => {
            if (!auth) {
                return null;
            }

            const session = await auth.api.getSession({ headers: request.headers });

            return session?.user?.id ? { userId: session.user.id } : null;
        },
        routes: {},
        shardDO: env.SHARD,
    });
};

/** This isolate's worker, built on first use. The caller has awaited `ensureAuth`. */
export const controlPlaneWorker = (env: ControlPlaneEnv): LunoraWorker => {
    worker ??= buildWorker(env);

    return worker;
};
