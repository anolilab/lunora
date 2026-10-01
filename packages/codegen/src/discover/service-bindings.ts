import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { ts } from "ts-morph";

import type { ServiceBindingIR } from "../ir";
import { readProjectConfigLiterals } from "../project-config-file";

/** A JS identifier — both the `ctx.services.<key>` name and an RPC `entrypoint` export must be one. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/u;

/**
 * The wrangler config files a service folder may hold, in wrangler's order.
 * Mirrors `WRANGLER_FILES` in `@lunora/config` (`cloudflare/wrangler-path.ts`),
 * which this package cannot import — change both together.
 */
const SERVICE_CONFIG_FILES = ["wrangler.jsonc", "wrangler.json"] as const;

/** `documentParser` → `SERVICE_DOCUMENT_PARSER`, the `services[].binding` Lunora writes. */
const serviceBindingName = (key: string): string => `SERVICE_${key.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/gu, "_").toUpperCase()}`;

/** The slice of a service's wrangler config (top level or one `env.<name>` block) Lunora reads. */
interface ServiceWranglerScope {
    main?: unknown;
    name?: unknown;
    route?: unknown;
    routes?: unknown;
    workers_dev?: unknown;
}

type ServiceWrangler = ServiceWranglerScope & { env?: Record<string, ServiceWranglerScope | undefined> };

/** A service folder's wrangler config, parsed (comments and trailing commas allowed). */
const readServiceWrangler = (key: string, directory: string): { config: ServiceWrangler; path: string } => {
    const path = SERVICE_CONFIG_FILES.map((file) => join(directory, file)).find((candidate) => existsSync(candidate));

    if (path === undefined) {
        const toml = existsSync(join(directory, "wrangler.toml")) ? " (its wrangler.toml is not read — Lunora reads a service's config as JSON(C) only)" : "";

        throw new Error(`@lunora/codegen: service "${key}" points at ${directory}, which has no wrangler.jsonc / wrangler.json${toml}`);
    }

    const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));

    if (parsed.error !== undefined || typeof parsed.config !== "object" || parsed.config === null) {
        throw new Error(`@lunora/codegen: service "${key}": ${path} is not valid JSON(C)`);
    }

    return { config: parsed.config as ServiceWrangler, path };
};

/**
 * Whether a scope serves on `*.workers.dev` with no route: wrangler turns
 * `workers_dev` on by default only when no route is set. An env block inherits
 * both keys from the top level.
 */
const isPublicWithoutRoute = (scope: ServiceWranglerScope, top: ServiceWranglerScope): boolean => {
    const route = scope.route ?? top.route;
    const routes = scope.routes ?? top.routes;
    const routed = route !== undefined || (Array.isArray(routes) && routes.length > 0);

    return !routed && (scope.workers_dev ?? top.workers_dev) !== false;
};

const resolveService = (projectRoot: string, key: string, declaration: { dir: string; entrypoint?: string }): ServiceBindingIR => {
    if (!IDENTIFIER_RE.test(key)) {
        throw new Error(`@lunora/codegen: service key "${key}" must be an identifier — it becomes ctx.services.${key}`);
    }

    if (declaration.entrypoint !== undefined && !IDENTIFIER_RE.test(declaration.entrypoint)) {
        throw new Error(`@lunora/codegen: service "${key}": entrypoint "${declaration.entrypoint}" must name an exported WorkerEntrypoint class`);
    }

    const directory = isAbsolute(declaration.dir) ? declaration.dir : resolve(projectRoot, declaration.dir);
    const { config, path } = readServiceWrangler(key, directory);
    const { main, name } = config;

    if (typeof name !== "string" || name === "") {
        throw new Error(`@lunora/codegen: service "${key}": ${path} declares no Worker "name"`);
    }

    if (typeof main !== "string" || main === "") {
        throw new Error(`@lunora/codegen: service "${key}": ${path} declares no "main" entry module`);
    }

    const environments = Object.entries(config.env ?? {}).map(([environment, scope]) => [environment, scope ?? {}] as const);

    return {
        binding: serviceBindingName(key),
        ...(declaration.entrypoint === undefined ? {} : { entrypoint: declaration.entrypoint }),
        envWorkers: Object.fromEntries(
            environments.flatMap(([environment, scope]) => (typeof scope.name === "string" && scope.name !== "" ? [[environment, scope.name]] : [])),
        ),
        main: resolve(directory, main),
        name: key,
        publicScopes: [
            ...(isPublicWithoutRoute(config, config) ? [""] : []),
            ...environments.filter(([, scope]) => isPublicWithoutRoute(scope, config)).map(([environment]) => environment),
        ],
        worker: name,
        wranglerPath: path,
    };
};

/**
 * Resolve every `services` entry in `lunora.config.*` (plan 457) into the binding
 * Lunora wires: the Worker name and entry module come from the service's own
 * wrangler config, so they have one source of truth. Returns `[]` when no
 * service is declared; throws, naming the entry, on anything codegen cannot wire
 * — an unreadable declaration, a missing folder or config, a nameless Worker.
 */
const resolveServiceBindings = (projectRoot: string): ServiceBindingIR[] => {
    const { services } = readProjectConfigLiterals(projectRoot);

    if (services?.unreadable === true) {
        throw new Error(
            '@lunora/codegen: lunora.config `services` must be an inline object of { dir: "…", entrypoint?: "…" } string literals — codegen reads it without running the file',
        );
    }

    const resolved = Object.entries(services?.declared ?? {})
        .map(([key, declaration]) => resolveService(projectRoot, key, declaration))
        .toSorted((a, b) => a.name.localeCompare(b.name));

    // `docParser` and `doc_parser` both become `SERVICE_DOC_PARSER`; one binding
    // cannot serve two keys.
    for (const [index, service] of resolved.entries()) {
        const clash = resolved.slice(index + 1).find((other) => other.binding === service.binding);

        if (clash !== undefined) {
            throw new Error(`@lunora/codegen: services "${service.name}" and "${clash.name}" both map to the binding ${service.binding} — rename one`);
        }
    }

    return resolved;
};

/**
 * The non-throwing {@link resolveServiceBindings}, for the tools around codegen
 * (dev, deploy, doctor, the Vite plugin): a declaration codegen rejects comes back as `error`
 * with no services, so each caller decides how loud to be — codegen itself
 * already throws on it.
 */
const readServiceBindings = (projectRoot: string): { error?: string; services: ServiceBindingIR[] } => {
    try {
        return { services: resolveServiceBindings(projectRoot) };
    } catch (error: unknown) {
        return { error: error instanceof Error ? error.message : String(error), services: [] };
    }
};

export { readServiceBindings, resolveServiceBindings };
