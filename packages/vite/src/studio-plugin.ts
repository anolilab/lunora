import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Shared studio-hosting helpers from the internal `@cirrus/config` layer.
// `@cirrus/cli`'s `cirrus dev` imports the same module, so the Vite route and
// the CLI server render an identical studio. The heavy `@cirrus/studio` SPA it
// hosts stays an optional peer — these helpers resolve its prebuilt assets
// lazily (and degrade gracefully when it isn't installed).
import { detectAgentRules } from "@cirrus/config";
import type { StudioAssets } from "@cirrus/config/studio-host";
import {
    handlePolicyScaffoldRequest,
    handleSchemaEditRequest,
    loadStudioAssets,
    POLICY_SCAFFOLD_ENDPOINT,
    renderStudioHtml,
    resolveAdminToken,
    SCHEMA_EDIT_ENDPOINT,
    studioAssetsStamp,
} from "@cirrus/config/studio-host";
import type { Plugin, ViteDevServer } from "vite";

/** Dev-server path the studio SPA is served from. */
const STUDIO_PATH = "/__cirrus";
/** Static asset routes the studio document references. */
const STUDIO_SCRIPT_PATH: string = `${STUDIO_PATH}/studio.js`;
const STUDIO_STYLE_PATH: string = `${STUDIO_PATH}/styles.css`;

const LEADING_SLASH = /^\//;
const TRAILING_SLASH = /\/$/;

/** Write a 200 response with the given body and content type. */
const sendOk = (response: ServerResponse, body: Buffer | string, contentType: string): void => {
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.end(body);
};

/** Read a request body to a string, bounded so a runaway upload can't OOM dev. */
const readBody = async (request: IncomingMessage): Promise<string> =>
    await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        request.on("data", (chunk: Buffer) => {
            size += chunk.length;

            if (size > 1_000_000) {
                reject(new Error("schema-edit body too large"));

                return;
            }

            chunks.push(chunk);
        });
        request.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });
        request.on("error", reject);
    });

/** Write a JSON response with the given status — shared by the local-dev endpoints below. */
const respondJson = (response: ServerResponse, status: number, body: unknown): void => {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
};

/**
 * Serve the local schema-edit endpoint (plan 024 Item 3): `GET` returns the
 * parsed source schema; `POST` applies an additive edit + reruns codegen (or
 * rejects a destructive edit with `needsMigration`). Local-dev-only — already
 * loopback-gated by the caller, like the rest of `/__cirrus`.
 */
const serveSchemaEdit = (request: IncomingMessage, response: ServerResponse, projectRoot: string): void => {
    const respond = (status: number, body: unknown): void => {
        respondJson(response, status, body);
    };

    if (request.method === "GET") {
        const result = handleSchemaEditRequest({ method: "GET", projectRoot });

        respond(result.status, result.body);

        return;
    }

    const handleBody = async (): Promise<void> => {
        try {
            const raw = await readBody(request);
            let parsed: unknown;

            try {
                parsed = raw === "" ? undefined : JSON.parse(raw);
            } catch {
                respond(400, { error: "invalid-json", ok: false });

                return;
            }

            const result = handleSchemaEditRequest({ body: parsed, method: request.method ?? "POST", projectRoot });

            respond(result.status, result.body);
        } catch (error: unknown) {
            respond(500, { error: error instanceof Error ? error.message : String(error), ok: false });
        }
    };

    handleBody().catch(() => {
        // `handleBody` already responds on every error path; this guards against
        // an unexpected throw so the promise never floats unhandled.
    });
};

/**
 * Serve the local policy-scaffold endpoint (plan 025 Item 3): `POST` writes a
 * new deny-by-default `name.policies.ts` stub, or appends `.use(rls(...))` to
 * an existing procedure chain, then reruns codegen (a destructive rewrite is
 * refused with `needsManualEdit`). Local-dev-only — already loopback-gated by
 * the caller, like the rest of `/__cirrus`.
 */
const servePolicyScaffold = (request: IncomingMessage, response: ServerResponse, projectRoot: string): void => {
    const respond = (status: number, body: unknown): void => {
        respondJson(response, status, body);
    };

    const handleBody = async (): Promise<void> => {
        try {
            const raw = await readBody(request);
            let parsed: unknown;

            try {
                parsed = raw === "" ? undefined : JSON.parse(raw);
            } catch {
                respond(400, { error: "invalid-json", ok: false });

                return;
            }

            const result = handlePolicyScaffoldRequest({ body: parsed, method: request.method ?? "POST", projectRoot });

            respond(result.status, result.body);
        } catch (error: unknown) {
            respond(500, { error: error instanceof Error ? error.message : String(error), ok: false });
        }
    };

    handleBody().catch(() => {
        // `handleBody` already responds on every error path; this guards against
        // an unexpected throw so the promise never floats unhandled.
    });
};

/**
 * Build the user-facing studio URL from the dev server's resolved address.
 * Pure so it can be unit-tested without a live server. Prefers Vite's own
 * `resolvedUrls.local` (honours `host` / `base` / https); falls back to the raw
 * socket address, bracketing IPv6 and normalising the wildcard host.
 */
const buildStudioUrl = (input: { address?: AddressInfo | string; base?: string; resolvedLocal?: string }): string => {
    const path = STUDIO_PATH.replace(LEADING_SLASH, "");

    if (input.resolvedLocal !== undefined && input.resolvedLocal !== "") {
        const origin = input.resolvedLocal.endsWith("/") ? input.resolvedLocal.slice(0, -1) : input.resolvedLocal;

        return `${origin}/${path}`;
    }

    const base = input.base === undefined || input.base === "/" ? "" : input.base.replace(TRAILING_SLASH, "");

    if (input.address === undefined || typeof input.address === "string") {
        return `http://localhost:5173${base}/${path}`;
    }

    const host = input.address.address === "::" || input.address.address === "0.0.0.0" ? "localhost" : input.address.address;
    const bracketed = host.includes(":") ? `[${host}]` : host;

    return `http://${bracketed}:${String(input.address.port)}${base}/${path}`;
};

/**
 * Parse the request pathname, tolerating a query string and a trailing slash so
 * `/__cirrus`, `/__cirrus?x`, `/__cirrus/`, and `/__cirrus/?x` all match.
 */
const pathnameOf = (url: string): string => {
    try {
        return new URL(url, "http://localhost").pathname.replace(TRAILING_SLASH, "");
    } catch {
        return url;
    }
};

/**
 * Connect middleware that serves the static studio. Extracted from
 * `configureServer` so each function stays small. Caches the asset bytes but
 * re-reads them when the built files change on disk (compared via
 * {@link studioAssetsStamp}), so a `@cirrus/studio` rebuild is picked up live
 * without a dev server restart.
 */
const createStudioHandler = (
    server: ViteDevServer,
    isNonLoopbackBind: boolean,
): ((request: IncomingMessage, response: ServerResponse, next: () => void) => void) => {
    let assets: StudioAssets | undefined;
    let assetsStamp: number | undefined;
    let html: string | undefined;

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime value can be undefined on a mocked server even though the type says string
    const projectRoot = server.config.root ?? process.cwd();

    return (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
        const pathname = pathnameOf(request.url ?? "");

        // Own the mount and everything under it (`/__cirrus`, `/__cirrus/`,
        // `/__cirrus/data`, …); anything else passes through.
        if (pathname !== STUDIO_PATH && !pathname.startsWith(`${STUDIO_PATH}/`)) {
            next();

            return;
        }

        // The studio ships admin tooling that assumes the developer is the
        // only consumer — never expose it on a non-loopback bind (`--host`).
        if (isNonLoopbackBind) {
            response.statusCode = 403;
            response.setHeader("Content-Type", "text/plain");
            response.end("Cirrus studio is only available on loopback hosts in dev.");

            return;
        }

        // Local schema-edit endpoint (plan 024). Loopback-gated above; never the
        // worker. Intercept before the SPA fallback so it isn't shadowed.
        if (pathname === SCHEMA_EDIT_ENDPOINT) {
            serveSchemaEdit(request, response, projectRoot);

            return;
        }

        // Local policy-scaffold endpoint (plan 025 Item 3). Same loopback gate
        // and codegen toolchain as the schema editor above.
        if (pathname === POLICY_SCAFFOLD_ENDPOINT) {
            servePolicyScaffold(request, response, projectRoot);

            return;
        }

        // Static assets are exact paths; every other route under the mount is an
        // SPA route and gets the history fallback (the document) below, so a hard
        // load of a deep link like `/__cirrus/data` boots the router there.
        if (pathname === STUDIO_SCRIPT_PATH || pathname === STUDIO_STYLE_PATH) {
            // Re-read the bytes when the built studio files change on disk so a
            // mid-session `@cirrus/studio` rebuild is served without a restart.
            const stamp = studioAssetsStamp();

            if (assets === undefined || stamp !== assetsStamp) {
                assets = loadStudioAssets(server.config.logger);
                assetsStamp = stamp;
            }

            if (assets === undefined) {
                response.statusCode = 501;
                response.setHeader("Content-Type", "text/plain");
                response.end("Cirrus studio assets not found — install and build @cirrus/studio.");

                return;
            }

            const isScript = pathname === STUDIO_SCRIPT_PATH;

            sendOk(response, isScript ? assets.script : assets.styles, isScript ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");

            return;
        }

        // Built once per dev session: the basepath is fixed, and the admin token
        // is read from `.dev.vars` at startup.
        html ??= renderStudioHtml({
            adminToken: resolveAdminToken(projectRoot),
            basePath: STUDIO_PATH,
            // Loopback-only dev route (it 403s on a non-loopback bind), so the
            // developer owns the data — let them edit rows, run-as a user, and edit
            // the schema by default.
            dataEditable: true,
            rulesInstalled: detectAgentRules(projectRoot).installed,
            runAsIdentity: true,
            schemaEditable: true,
            scriptSrc: STUDIO_SCRIPT_PATH,
            styleHref: STUDIO_STYLE_PATH,
        });

        sendOk(response, html, "text/html; charset=utf-8");
    };
};

/**
 * Vite plugin that serves the composed Cirrus studio at
 * {@link STUDIO_PATH} during dev and prints its URL once the server is
 * listening. Dev-only (`apply: "serve"`); it adds nothing to production builds.
 *
 * Because `cirrus dev` spawns Vite, this makes the studio available on
 * `cirrus dev` and on a plain `vite` with no per-project files. The studio
 * is served as a prebuilt static bundle, independent of the host app.
 */
const studioPlugin = (): Plugin => {
    return {
        apply: "serve",
        configureServer(server: ViteDevServer) {
            // `config.server` is typed required, but partial/mocked dev-server objects omit it.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive against partial ViteDevServer objects
            const configuredHost = server.config.server?.host;
            const isNonLoopbackBind =
                configuredHost !== undefined &&
                configuredHost !== false &&
                configuredHost !== "localhost" &&
                configuredHost !== "127.0.0.1" &&
                configuredHost !== "::1";

            server.middlewares.use(createStudioHandler(server, isNonLoopbackBind));

            // Surface the studio URL at startup. Returned hook runs after
            // internal middlewares are installed.
            return () => {
                const announce = (): void => {
                    const url = buildStudioUrl({
                        address: server.httpServer?.address() ?? undefined,
                        base: server.config.base,
                        resolvedLocal: server.resolvedUrls?.local[0],
                    });

                    // Match Vite's banner format so the line slots in beneath the
                    // Local/Network URLs (`Cirrus:` padded to align the colons).
                    server.config.logger.info(`  [32m➜[39m  [1mCirrus[22m:  [36m${url}[39m`);
                };

                // Preferred: splice the line into Vite's startup banner by
                // wrapping `printUrls`, so it prints right under Local/Network
                // (and reprints when the user hits `u`). Fall back to announcing
                // on `listening` when `printUrls` is unavailable (mocked server).
                if (typeof server.printUrls === "function") {
                    const printUrls = server.printUrls.bind(server);

                    // eslint-disable-next-line no-param-reassign -- intentionally wrap the live dev server's printUrls so our line prints under Local/Network
                    server.printUrls = (): void => {
                        printUrls();
                        announce();
                    };
                } else if (server.httpServer?.listening === true) {
                    announce();
                } else {
                    server.httpServer?.once("listening", announce);
                }
            };
        },
        name: "cirrus:studio",
    };
};

export { buildStudioUrl, STUDIO_PATH, STUDIO_SCRIPT_PATH, STUDIO_STYLE_PATH, studioPlugin };
