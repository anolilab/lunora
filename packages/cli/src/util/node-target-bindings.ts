/**
 * The wrangler config rules `lunora dev --target node` and `lunora deploy --target node` share: what a binding may be named,
 * which declared sections the Node host composes, and the `WORKER_ENV` it sets itself. One copy, so the dev host and the
 * container refuse and report the same config the same way.
 */

import type { Node as JsonNode } from "jsonc-parser";
import { findNodeAtLocation, parseTree } from "jsonc-parser";

/** What the host tells the app it runs as: `development` under `lunora dev`, `production` in the deployed container. */
const WORKER_ENV = "WORKER_ENV";

/**
 * Wrangler's rule for a binding name: a JavaScript identifier. A Durable Object binding's name is also a directory under the
 * host's data directory, so anything else (`..`, `a/b`) could put shard files outside it.
 */
const BINDING_NAME = /^[A-Za-z_$][\w$]*$/u;

/**
 * Top-level wrangler keys the Node host composes, or that configure the Worker rather than bind something into `env`. Every
 * other declared key is reported as unbound: an allowlist, so a binding section wrangler adds later is named rather than
 * silently missing. `durable_objects` is checked per binding, since one bound to another worker's class is unbound.
 */
const COMPOSED_OR_CONFIG_KEYS: ReadonlySet<string> = new Set([
    "$schema",
    "account_id",
    "alias",
    "base_dir",
    "build",
    "cache",
    "compatibility_date",
    "compatibility_flags",
    "define",
    "dev",
    "durable_objects",
    "env",
    // Cache options for named entrypoints; a typed entry (a workflow) is reported on its own by `unboundExports`.
    "exports",
    "find_additional_modules",
    "first_party_worker",
    "hyperdrive",
    "jsx_factory",
    "jsx_fragment",
    "keep_names",
    "keep_vars",
    "legacy_env",
    "limits",
    "logpush",
    "main",
    "migrations",
    "minify",
    "name",
    "no_bundle",
    "node_compat",
    "observability",
    "placement",
    "preserve_file_names",
    "preview_urls",
    "route",
    "routes",
    "rules",
    "secrets",
    "secrets_store_secrets",
    "send_metrics",
    "streaming_tail_consumers",
    "tail_consumers",
    "triggers",
    "tsconfig",
    "upload_source_maps",
    "usage_model",
    "vars",
    "workers_dev",
]);

/**
 * The queue `@lunora/mail`'s producer writes to: the name the `mail` starter's wrangler config gives it, and the one
 * `@lunora/platform-node`'s mail host reserves. A producer bound to it is how the host knows the app queues mail.
 */
const MAIL_QUEUE_NAME = "lunora-mail";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The `queues.producers` or `queues.consumers` entries of a wrangler config, skipping anything that is not an object. */
const queueEntries = (queues: unknown, kind: "consumers" | "producers"): Record<string, unknown>[] => {
    const entries = isRecord(queues) ? queues[kind] : undefined;

    return Array.isArray(entries) ? entries.filter((entry): entry is Record<string, unknown> => isRecord(entry)) : [];
};

/**
 * Every binding of an app {@link MAIL_QUEUE_NAME} producer: empty when the app queues no mail. Each is bound to the platform's
 * mail queue, so an app that names the queue under two bindings can use either.
 */
const mailQueueBindings = (queues: unknown, configName: string): string[] =>
    queueEntries(queues, "producers")
        .filter((entry) => entry.queue === MAIL_QUEUE_NAME)
        .map((producer) => {
            if (typeof producer.binding !== "string" || !BINDING_NAME.test(producer.binding)) {
                throw new Error(
                    `--target node binds each ${MAIL_QUEUE_NAME} queue producer by its "binding" name, and one in ${configName} has ${producer.binding === undefined ? "none" : `${JSON.stringify(producer.binding)}, which is not a valid binding name`}`,
                );
            }

            return producer.binding;
        });

/**
 * A binding list the Node host reads (`hyperdrive`, `secrets_store_secrets`): every entry must name its binding. One that
 * does not used to be dropped, so the host started and the worker read `undefined` where the app expected a binding.
 */
const bindingNames = (value: unknown, section: string, configName: string): string[] => {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value)) {
        throw new TypeError(`--target node reads ${section} in ${configName} as a list of bindings, and it is ${JSON.stringify(value)}`);
    }

    return value.map((entry: unknown, index) => {
        const name = isRecord(entry) ? entry.binding : undefined;

        if (typeof name !== "string" || !BINDING_NAME.test(name)) {
            throw new Error(
                `--target node binds each ${section} entry by its "binding" name, and ${section}[${String(index)}] in ${configName} has ${name === undefined ? "none" : `${JSON.stringify(name)}, which is not a valid binding name`}`,
            );
        }

        return name;
    });
};

/** `durable_objects.bindings`: each entry needs a string `name` and `class_name`, both identifiers. */
const durableObjectEntries = (value: unknown, configName: string): { className: string; name: string; scriptName: unknown }[] => {
    if (value === undefined || value === null) {
        return [];
    }

    const bindings = isRecord(value) ? value.bindings : undefined;

    if (bindings !== undefined && !Array.isArray(bindings)) {
        throw new Error(`--target node reads durable_objects.bindings in ${configName} as a list of bindings, and it is ${JSON.stringify(bindings)}`);
    }

    if (!isRecord(value)) {
        throw new Error(`--target node reads durable_objects in ${configName} as { "bindings": [...] }, and it is ${JSON.stringify(value)}`);
    }

    return (bindings ?? []).map((entry: unknown, index) => {
        const where = `durable_objects.bindings[${String(index)}] in ${configName}`;

        if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.class_name !== "string") {
            throw new Error(`--target node constructs each Durable Object binding from its "name" and "class_name", and ${where} lacks one`);
        }

        // The name becomes a directory under the host's data directory: anything but an identifier ("..", "a/b") could put
        // shard files outside it.
        if (!BINDING_NAME.test(entry.name)) {
            throw new Error(
                `--target node stores each Durable Object binding's shards in a directory named after it, and the binding ${JSON.stringify(entry.name)} in ${configName} is not a valid binding name (a JavaScript identifier such as SHARD)`,
            );
        }

        if (!BINDING_NAME.test(entry.class_name)) {
            throw new Error(
                `--target node imports each Durable Object class by name, and ${where} names ${JSON.stringify(entry.class_name)}, which is not a class name`,
            );
        }

        return { className: entry.class_name, name: entry.name, scriptName: entry.script_name };
    });
};

/**
 * Every name that lands on `env` comes from one place. Built in a fixed order (vars, then each secret, Hyperdrive and the
 * Durable Objects), a later source would silently replace an earlier one, and the code reading it gets the wrong kind of value.
 */
const refuseEnvCollisions = (sources: ReadonlyArray<{ names: ReadonlyArray<string>; repeatable?: boolean; source: string }>, configName: string): void => {
    const owners = new Map<string, string[]>();

    for (const { names, repeatable, source } of sources) {
        // A repeat within secrets.required asks for one variable twice, which is harmless; a repeat within a binding list
        // declares two bindings under one name, and the later replaces the earlier.
        for (const name of repeatable === true ? new Set(names) : names) {
            owners.set(name, [...(owners.get(name) ?? []), source]);
        }
    }

    const collisions = [...owners].filter(([, from]) => from.length > 1).map(([name, from]) => `${name} (${from.join(" and ")})`);

    if (collisions.length > 0) {
        throw new Error(
            `--target node puts every var, secret and binding on env under its own name, and ${configName} declares ${collisions.join(", ")} more than once: one would silently replace the other. Rename one of them`,
        );
    }
};

/** An environment variable name as a container runtime sets one. */
const ENV_NAME = /^[A-Z_a-z]\w*$/u;

/**
 * The one name that is not an ordinary key: in an object literal, or under a plain assignment, `__proto__` sets the prototype.
 * `constructor` and `prototype` are ordinary own properties wherever env is built with own-property semantics, as it is.
 */
const RESERVED_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__"]);

/**
 * `vars`: an object of names and values. Its names follow one of two rules. The container (`"environment"`) lets the
 * environment variable of the same name override each var, so every name must be one a container runtime can set. The dev
 * host (`"binding"`) reads them only from the config and `.dev.vars`, so any wrangler var name is fine there (`API-URL`,
 * `app.mode`) except `__proto__`. Values are JSON, as wrangler takes them (`null`, numbers, booleans and objects included), and
 * reach the worker as that data.
 */
const declaredVariables = (value: unknown, configName: string, names: "binding" | "environment"): Record<string, unknown> => {
    if (value === undefined || value === null) {
        return {};
    }

    if (!isRecord(value)) {
        throw new Error(`--target node reads vars in ${configName} as an object of names and values, and it is ${JSON.stringify(value)}`);
    }

    const invalid = Object.keys(value).filter((name) => RESERVED_OBJECT_KEYS.has(name) || (names === "environment" && !ENV_NAME.test(name)));

    if (invalid.length > 0) {
        const list = invalid.map((name) => JSON.stringify(name)).join(", ");
        const one = invalid.length === 1;

        if (names === "environment") {
            throw new Error(
                `--target node lets the environment variable of the same name override each var, and vars in ${configName} has ${list}, which ${one ? "is not" : "are not"} an environment variable name`,
            );
        }

        throw new Error(
            `--target node puts each var on env under its name, and vars in ${configName} has ${list}, which ${one ? "sets" : "set"} an object's prototype rather than naming a var`,
        );
    }

    return { ...value };
};

/**
 * The `secrets.required` names, or a throw naming the field when it is not a list of names. Dropping a malformed value would
 * deploy a server that starts without the secrets the app needs, the failure this check exists to prevent.
 */
const requiredSecretNames = (secrets: unknown, configName: string): string[] => {
    if (secrets === undefined || secrets === null) {
        return [];
    }

    const refuse = (problem: string): never => {
        throw new Error(
            `--target node checks every secrets.required name at startup, and ${problem} in ${configName}: secrets must be { "required": [...] }, an array of environment variable names such as ["API_KEY"]`,
        );
    };

    if (typeof secrets !== "object" || Array.isArray(secrets)) {
        return refuse(`secrets is ${JSON.stringify(secrets)}`);
    }

    // `required` is the object's only field: a misspelling ("require") would otherwise read as "no secrets" and skip the check.
    const unknown = Object.keys(secrets).filter((key) => key !== "required");

    if (unknown.length > 0) {
        return refuse(`secrets has ${unknown.map((key) => JSON.stringify(key)).join(", ")} instead of "required"`);
    }

    const { required } = secrets as { required?: unknown };

    if (!Array.isArray(required)) {
        return refuse(`secrets.required is ${JSON.stringify(required)}`);
    }

    // An environment variable name: anything else could never be set on a container, so the server could never start.
    // Not `__proto__` either: a secret of that name can never be read back out of `.dev.vars` or the environment.
    const invalid = required.filter((name) => typeof name !== "string" || !ENV_NAME.test(name) || RESERVED_OBJECT_KEYS.has(name));

    if (invalid.length > 0) {
        return refuse(
            `secrets.required lists ${invalid.map((name) => JSON.stringify(name)).join(", ")}, which ${invalid.length === 1 ? "is not" : "are not"} an environment variable name`,
        );
    }

    return required as string[];
};

/**
 * Every `__proto__` key under `vars` (the top level's, and the selected environment's), at any depth, read from the config's raw
 * syntax: parsing applies such a key as a prototype instead of keeping it, so after parsing it cannot be seen and its value is
 * silently lost.
 */
const prototypeKeysUnderVariables = (text: string, environment?: string): string[] => {
    const root = parseTree(text);
    const found: string[] = [];

    const walk = (node: JsonNode, path: string): void => {
        for (const child of node.children ?? []) {
            if (child.type === "property") {
                const [key, value] = child.children ?? [];
                const name = String(key?.value);
                const here = `${path}.${name}`;

                if (name === "__proto__") {
                    found.push(here);
                }

                if (value !== undefined) {
                    walk(value, here);
                }
            } else {
                walk(child, path);
            }
        }
    };

    const scopes: [string[], string][] = [
        [["vars"], "vars"],
        ...(environment === undefined ? [] : [[["env", environment, "vars"], `env.${environment}.vars`] as [string[], string]]),
    ];

    for (const [location, label] of scopes) {
        const variables = root === undefined ? undefined : findNodeAtLocation(root, location);

        if (variables !== undefined) {
            walk(variables, label);
        }
    }

    return found;
};

/** Refuse a `__proto__` key under `vars`, which parsing would turn into a prototype and lose (see {@link prototypeKeysUnderVariables}). */
const refusePrototypeKeys = (text: string, configName: string, environment?: string): void => {
    const prototypeKeys = prototypeKeysUnderVariables(text, environment);

    if (prototypeKeys.length > 0) {
        throw new Error(
            `--target node passes vars to the worker as data, and ${configName} uses __proto__ as a key at ${prototypeKeys.join(", ")}: parsing applies it as a prototype instead of keeping it, so its value would silently be lost. Rename the key`,
        );
    }
};

/**
 * The `hyperdrive` binding names, at most one: both Node hosts build the binding from the process's one `DATABASE_URL`, so a
 * second binding would silently reach the same database as the first.
 */
const hyperdriveBindingNames = (value: unknown, configName: string): string[] => {
    const names = bindingNames(value, "hyperdrive", configName);

    // A second binding would need a naming scheme for its URL that nothing reads yet.
    if (names.length > 1) {
        throw new Error(
            `--target node builds the Hyperdrive binding from DATABASE_URL, so it serves one binding, and ${configName} declares ${names.join(", ")}`,
        );
    }

    return names;
};

/** Whether a declared section binds anything: an empty list or object is no binding. */
const isDeclared = (value: unknown): boolean => {
    if (Array.isArray(value)) {
        return value.length > 0;
    }

    if (typeof value === "object" && value !== null) {
        return Object.keys(value).length > 0;
    }

    return value !== undefined && value !== null;
};

/**
 * The `exports` entries that declare something rather than configure it: an entry with a `type` (a `workflow`, or any other)
 * defines what the Cloudflare runtime would run, which neither Node host composes. An untyped entry only sets a named
 * entrypoint's cache options.
 */
const unboundExports = (exportsMap: unknown): string[] =>
    isRecord(exportsMap)
        ? Object.entries(exportsMap).flatMap(([name, entry]) => {
              if (!isRecord(entry) || typeof entry.type !== "string") {
                  return [];
              }

              // The worker both hosts serve is the entry module's default export: declaring it is declaring what runs.
              if (entry.type === "worker" && name === "default") {
                  return [];
              }

              return [`exports.${name} (${entry.type})`];
          })
        : [];

/**
 * The declared top-level sections of a wrangler config (or one environment's view of it) that the Node host leaves unbound,
 * and each typed `exports` entry by name.
 */
const unboundSections = (config: Readonly<Record<string, unknown>>): string[] => [
    ...Object.keys(config).filter((key) => !COMPOSED_OR_CONFIG_KEYS.has(key) && isDeclared(config[key])),
    ...unboundExports(config["exports"]),
];

/**
 * The host sets `WORKER_ENV` itself. A var, secret or binding of that name would replace it on `env`, and the app would no
 * longer see the mode it runs in: a container that reads `development` turns on development-only behaviour, such as mail
 * capture, in production, and a dev host that reads a binding object turns it off.
 */
const refuseWorkerEnvOverride = (
    sources: ReadonlyArray<{ names: ReadonlyArray<string>; source: string }>,
    configName: string,
    mode: "development" | "production",
): void => {
    const setBy = sources.filter(({ names }) => names.includes(WORKER_ENV)).map(({ source }) => source);

    if (setBy.length === 0) {
        return;
    }

    const consequence =
        mode === "production"
            ? `a ${WORKER_ENV} of development turns on development-only behaviour, such as mail capture, in production`
            : `the binding would replace it on env, and the app would no longer see that it runs in development`;

    throw new Error(`--target node sets ${WORKER_ENV} to ${mode} itself, and ${configName} also declares it in ${setBy.join(", ")}. Remove it: ${consequence}`);
};

export {
    BINDING_NAME,
    bindingNames,
    declaredVariables,
    durableObjectEntries,
    hyperdriveBindingNames,
    isDeclared,
    MAIL_QUEUE_NAME,
    mailQueueBindings,
    queueEntries,
    refuseEnvCollisions,
    refusePrototypeKeys,
    refuseWorkerEnvOverride,
    requiredSecretNames,
    unboundSections,
    WORKER_ENV,
};
