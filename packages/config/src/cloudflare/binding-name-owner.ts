/**
 * Which top-level `wrangler.jsonc` section already binds a name, so a reconciler
 * adding a binding of its own can step aside instead of writing a duplicate that
 * wrangler rejects.
 */
import type { WranglerShape } from "./wrangler-shape";

/** Sections that are a list of entries naming their binding with `name`, not `binding`. */
const NAME_KEYED_LIST_SECTIONS = new Set(["ratelimits", "send_email"]);

/** Sections whose `bindings` list names each entry with `name`. */
const NESTED_NAME_BINDING_SECTIONS = ["durable_objects", "logfwdr", "unsafe"] as const;

/** Sections whose object KEYS are the binding names. */
const KEYED_MAP_SECTIONS = new Set(["data_blobs", "text_blobs", "vars", "wasm_modules"]);

/** A plain (non-array) object. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const bindsName = (entry: unknown, field: string, name: string): boolean => isRecord(entry) && entry[field] === name;

/** Whether one top-level section's own value (object, list, or keyed map) binds `name`. */
const sectionBindsName = (section: string, value: unknown, name: string): boolean => {
    if (KEYED_MAP_SECTIONS.has(section)) {
        return isRecord(value) && Object.hasOwn(value, name);
    }

    const field = NAME_KEYED_LIST_SECTIONS.has(section) ? "name" : "binding";

    return Array.isArray(value) ? value.some((entry) => bindsName(entry, field, name)) : bindsName(value, "binding", name);
};

/**
 * Where `name` is already bound in the top-level config, as `section` (or
 * `section.sub`), else `undefined`. Covers every entry shape wrangler binds a
 * name with: a `{ binding }` object (`ai`, `browser`, …), a list of
 * `{ binding }` entries (`kv_namespaces`, `services`, `ai_search`, …), a list
 * of `{ name }` entries (`ratelimits`, `send_email`), a `bindings[].name` list
 * (`durable_objects`, `unsafe`, `logfwdr`), `queues.producers[].binding`, the
 * keys of `vars` / `wasm_modules` / `text_blobs` / `data_blobs`, and the
 * declared `secrets.required`. `env.*` blocks are skipped: they are separate
 * workers' configs as far as name clashes go.
 */
const bindingNameOwner = (parsed: WranglerShape, name: string): string | undefined => {
    const config = parsed as Record<string, unknown>;
    const owner = Object.entries(config).find(([section, value]) => section !== "env" && sectionBindsName(section, value, name));

    if (owner !== undefined) {
        return owner[0];
    }

    for (const section of NESTED_NAME_BINDING_SECTIONS) {
        const block = config[section];

        if (isRecord(block) && Array.isArray(block.bindings) && block.bindings.some((entry) => bindsName(entry, "name", name))) {
            return `${section}.bindings`;
        }
    }

    // Parsed from untrusted JSONC: `"producers": {}` parses too.
    const producers: unknown = parsed.queues?.producers;

    if (Array.isArray(producers) && producers.some((entry) => bindsName(entry, "binding", name))) {
        return "queues.producers";
    }

    const required = parsed.secrets?.required;

    if (Array.isArray(required) && required.includes(name)) {
        return "secrets.required";
    }

    return undefined;
};

export default bindingNameOwner;
