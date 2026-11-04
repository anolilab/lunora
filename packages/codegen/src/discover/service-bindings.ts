import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { ts } from "ts-morph";

import { COMPANION_BINDING, COMPANION_SERVICE_NAME, companionDirectory, companionName } from "../companion";
import type { ServiceBindingIR } from "../ir";
import { readProjectConfigLiterals, readProjectStudioCompanion } from "../project-config-file";

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

const resolveService = (projectRoot: string, key: string, declaration: { dir: string; entrypoint?: string; rpc?: false }): ServiceBindingIR => {
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
        // A named entrypoint is RPC unless declared `rpc: false`.
        ...(declaration.entrypoint === undefined || declaration.rpc === false ? {} : { rpcEntrypoint: declaration.entrypoint }),
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
            '@lunora/codegen: lunora.config `services` must be an inline object of { dir: "…", entrypoint?: "…", rpc?: false } literals — codegen reads it without running the file',
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

/**
 * The companion advisor Worker as a service binding, when `studio.companion` is on. Kept out of `resolveServiceBindings`: that list
 * types `ctx.services`, and the companion is Lunora's own Worker, not an app service. Only the callers that bind or deploy a Worker add it
 * (see `readBoundServiceBindings`). The folder need not exist yet: a refusal check or the reconcile can run before codegen writes it.
 * `lunoraDirectory` is the project's Lunora source folder (relative to `projectRoot`), where codegen writes `_generated/companion`.
 */
const companionServiceBinding = (projectRoot: string, lunoraDirectory = "lunora"): ServiceBindingIR | undefined => {
    if (!readProjectStudioCompanion(join(projectRoot, lunoraDirectory))) {
        return undefined;
    }

    const directory = companionDirectory(projectRoot, lunoraDirectory);

    return {
        binding: COMPANION_BINDING,
        envWorkers: {},
        main: join(directory, "src", "worker.ts"),
        name: COMPANION_SERVICE_NAME,
        publicScopes: [],
        worker: companionName(projectRoot),
        wranglerPath: join(directory, "wrangler.jsonc"),
    };
};

/**
 * `readServiceBindings` plus the companion, for the callers that must bind or run it: the reconcile into the app's `services[]`,
 * the deploy of services, and dev (the app's wrangler config carries the `ADVISOR_COMPANION` binding, so dev has to run that Worker too).
 * Callers that read the app's own services (the open-shard gate, `lunora preview`'s refusal, doctor) or RPC entrypoints (the companion
 * has none) keep `readServiceBindings`.
 */
const readBoundServiceBindings = (projectRoot: string, lunoraDirectory = "lunora"): { error?: string; services: ServiceBindingIR[] } => {
    const { error, services } = readServiceBindings(projectRoot);

    try {
        const companion = companionServiceBinding(projectRoot, lunoraDirectory);

        if (companion === undefined) {
            return { ...(error === undefined ? {} : { error }), services };
        }

        // Deploying both under one name would let the companion replace the app's service.
        const clash = services.find((service) => service.worker === companion.worker);

        if (clash !== undefined) {
            return {
                error: `lunora.config services.${clash.name} deploys as "${clash.worker}", the name the studio.companion Worker is given; rename that Worker or turn studio.companion off`,
                services,
            };
        }

        return { ...(error === undefined ? {} : { error }), services: [...services, companion] };
    } catch (companionError: unknown) {
        // The companion's Worker name is derived from the app's wrangler config; an unreadable one is reported like a bad `services` entry.
        return { error: error ?? (companionError instanceof Error ? companionError.message : String(companionError)), services };
    }
};

/**
 * `readBoundServiceBindings` for a dev session, which can start before codegen writes `_generated/companion/`: the companion is left
 * out until its wrangler config exists, rather than failing the session on the missing file. The next start enrolls it.
 */
const readDevServiceBindings = (projectRoot: string, lunoraDirectory = "lunora"): { error?: string; services: ServiceBindingIR[] } => {
    const bound = readBoundServiceBindings(projectRoot, lunoraDirectory);

    return { ...bound, services: bound.services.filter((service) => service.binding !== COMPANION_BINDING || existsSync(service.wranglerPath)) };
};

export { companionServiceBinding, readBoundServiceBindings, readDevServiceBindings, readServiceBindings, resolveServiceBindings };
