/**
 * `registry.json` parsing + validation. Pure (no I/O), so it's the easy unit to
 * test directly. Rejects path traversal on both `from` and `to`, and newlines in
 * env-var values (which would corrupt the line-oriented `.dev.vars`).
 */
import type { RegistryBinding, RegistryFile, RegistryManifest } from "./types";

/** A CR or LF — illegal in a `.dev.vars` value (it would inject a spurious line). */
const NEWLINE_PRESENT = /[\r\n]/u;

/**
 * A valid environment-variable key: a leading letter/underscore followed by
 * letters/digits/underscores. Anything else (a `=`, a newline, spaces, shell
 * metacharacters) would corrupt the line-oriented `.dev.vars` file — e.g.
 * `name: "FOO\nINJECTED=evil"` or `name: "FOO=bar"` would write extra/overlong
 * keys. Reject at parse time, before any value is written.
 */
const VALID_ENV_NAME = /^[A-Za-z_]\w*$/u;

/**
 * A valid registry item `name`. It is used as a path segment, as the lock key,
 * and — for schema-extension items — spliced into `lunora/schema.ts` as both an
 * import specifier (`./${name}/schema`) and an identifier (`.extend(${name}.extension)`).
 * Restricting it to a single safe identifier segment stops a hostile manifest
 * from injecting a path separator or breaking out of the import to smuggle code.
 */
const VALID_ITEM_NAME = /^[A-Za-z0-9][\w-]*$/u;

/** Validate + narrow a parsed JSON value into a {@link RegistryManifest}. */
const parseManifest = (raw: unknown, itemName: string): RegistryManifest => {
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`registry.json for "${itemName}" is not an object`);
    }

    const record = raw as Record<string, unknown>;
    const { name } = record;

    if (typeof name !== "string" || name.length === 0) {
        throw new Error(`registry.json for "${itemName}" is missing a string "name"`);
    }

    if (!VALID_ITEM_NAME.test(name)) {
        throw new Error(
            `registry.json for "${itemName}": name "${name}" must match ${VALID_ITEM_NAME.source} (letters, digits, "-", "_"; no path separators, "..", or code)`,
        );
    }

    const filesRaw = record.files;

    if (!Array.isArray(filesRaw)) {
        throw new TypeError(`registry.json for "${itemName}" is missing a "files" array`);
    }

    const files: RegistryFile[] = filesRaw.map((entry, index) => {
        if (typeof entry !== "object" || entry === null) {
            throw new Error(`registry.json "${itemName}": files[${String(index)}] is not an object`);
        }

        const fileRecord = entry as Record<string, unknown>;
        const { from } = fileRecord;
        const { to } = fileRecord;
        const { merge } = fileRecord;

        if (typeof from !== "string" || typeof to !== "string") {
            throw new TypeError(`registry.json "${itemName}": files[${String(index)}] needs string "from" and "to"`);
        }

        if (merge !== "create-or-skip" && merge !== "schema-extension") {
            throw new Error(`registry.json "${itemName}": files[${String(index)}].merge must be "create-or-skip" or "schema-extension"`);
        }

        // Reject path traversal on BOTH sides. `to` must stay inside the project;
        // `from` must stay inside the (possibly untrusted, giget-fetched) item dir —
        // otherwise a malicious manifest could read an arbitrary host file
        // (`from: "../../../../etc/passwd"`) and copy/print it.
        for (const [field, value] of [
            ["from", from],
            ["to", to],
        ] as const) {
            if (value.includes("..") || value.startsWith("/")) {
                throw new Error(`registry.json "${itemName}": files[${String(index)}].${field} "${value}" must be a relative path without ".."`);
            }
        }

        return { from, merge, to };
    });

    const asStringMap = (value: unknown): Record<string, string> | undefined =>
        typeof value === "object" && value !== null ? (value as Record<string, string>) : undefined;

    const deps = asStringMap(record.deps);
    const devDependencies = asStringMap(record.devDependencies);
    const requires = Array.isArray(record.requires) ? record.requires.filter((value): value is string => typeof value === "string") : undefined;
    const bindings = Array.isArray(record.bindings)
        ? (record.bindings as unknown[]).filter((value): value is RegistryBinding => {
              if (typeof value !== "object" || value === null) {
                  return false;
              }

              const bindingRecord = value as Record<string, unknown>;

              return Array.isArray(bindingRecord.path) && bindingRecord.path.every((segment) => typeof segment === "string");
          })
        : undefined;

    const envVariables = Array.isArray(record.envVars)
        ? (record.envVars as unknown[])
              .filter(
                  (value): value is Record<string, unknown> & { name: string } =>
                      typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string",
              )
              .map((entry) => {
                  const hasValue = typeof entry.value === "string";

                  // The key is written verbatim as `${name}=...` into `.dev.vars`; a
                  // newline or `=` (or any non-identifier char) would inject/overwrite
                  // an unrelated key. Enforce a strict env-var identifier shape.
                  if (!VALID_ENV_NAME.test(entry.name)) {
                      throw new Error(
                          `registry.json "${itemName}": envVars["${entry.name}"].name must match ${VALID_ENV_NAME.source} (letters, digits, underscore; no "=" or newline)`,
                      );
                  }

                  // `.dev.vars` is line-oriented; a newline in a value would inject a
                  // spurious key. Reject at parse time, before anything is written.
                  if (hasValue && NEWLINE_PRESENT.test(entry.value as string)) {
                      throw new Error(`registry.json "${itemName}": envVars["${entry.name}"].value must not contain a newline`);
                  }

                  return {
                      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
                      name: entry.name,
                      // Default to secret unless a concrete value is provided.
                      secret: typeof entry.secret === "boolean" ? entry.secret : !hasValue,
                      ...(hasValue ? { value: entry.value as string } : {}),
                  };
              })
        : undefined;

    return {
        bindings,
        deps,
        description: typeof record.description === "string" ? record.description : undefined,
        devDependencies,
        docs: typeof record.docs === "string" ? record.docs : undefined,
        envVars: envVariables,
        files,
        name,
        requires,
        title: typeof record.title === "string" ? record.title : undefined,
    };
};

export default parseManifest;
