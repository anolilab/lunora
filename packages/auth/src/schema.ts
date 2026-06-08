import type { TableDefinition } from "@cirrus/server";
import { defineTable } from "@cirrus/server";
import type { ColumnValidator, Validator } from "@cirrus/values";
import { v } from "@cirrus/values";
import { getAuthTables } from "better-auth/db";

import type { CirrusAuthOptions } from "./create-auth.js";

/**
 * The better-auth field-attribute shape we read. Mirrors `DBFieldAttribute`
 * from `@better-auth/core` structurally so this module needs no value import of
 * better-auth's types (which aren't re-exported from a stable path).
 */
interface AuthFieldAttribute {
    fieldName?: string;
    references?: { field: string; model: string };
    required?: boolean;
    type: ReadonlyArray<string> | string;
    unique?: boolean;
}

/** The validator for a field's `type`, before `nullable`/`unique` modifiers. */
const baseValidator = (attribute: AuthFieldAttribute): Validator => {
    // A foreign-key field is typed as the referenced table's id regardless of
    // its raw `string` storage type.
    if (attribute.references) {
        return v.id(attribute.references.model);
    }

    const { type } = attribute;

    // A `type` that is an array of string literals is a better-auth enum; Cirrus
    // has no literal validator, so it widens to `string` (the stored type).
    if (Array.isArray(type)) {
        return v.string();
    }

    switch (type) {
        case "boolean": {
            return v.boolean();
        }
        case "date": {
            return v.date();
        }
        case "number": {
            return v.number();
        }
        case "number[]": {
            return v.array(v.number());
        }
        case "string": {
            return v.string();
        }
        case "string[]": {
            return v.array(v.string());
        }
        // "json" and anything unrecognised: keep the row shape permissive rather
        // than fail schema generation on a plugin's exotic column type.
        default: {
            return v.any();
        }
    }
};

/**
 * Map one better-auth field attribute to a Cirrus validator. `required: false`
 * becomes `.nullable()` (the column is optional/absent), `unique` becomes
 * `.unique()`, and a `references` to another model becomes a typed `v.id(model)`
 * so the foreign key is type-checked end-to-end. Defaults are intentionally
 * **not** mapped to `.default()`: better-auth fills them in its own write layer
 * (its `defaultValue` is documented as not a DB-level default), so mirroring
 * them would double up.
 */
const fieldValidator = (attribute: AuthFieldAttribute): Validator => {
    // The `v.*` factories all return `ColumnValidator`; the cast recovers the
    // chainable modifier surface (`.nullable()`/`.unique()`) erased by typing
    // `baseValidator` to the common `Validator` so its switch arms unify.
    let validator = baseValidator(attribute) as ColumnValidator<unknown, unknown>;

    if (attribute.required === false) {
        validator = validator.nullable();
    }

    if (attribute.unique === true) {
        validator = validator.unique();
    }

    return validator;
};

/**
 * Derive Cirrus table definitions from a better-auth config — the bridge that
 * makes the **full** better-auth plugin ecosystem first-class Cirrus data.
 *
 * better-auth's own `getAuthTables(options)` already merges every configured
 * plugin's `schema` into one table map (core `user`/`session`/`account`/
 * `verification`, plus whatever the plugins on `options.plugins` add —
 * `organization`/`member`/`invitation`/`team`/`teamMember` from the
 * organization plugin, `role`/`banned`/… columns from admin, `passkey`,
 * `twoFactor`, `jwks`, …). This walks that map and emits an equivalent
 * `defineTable` for each, so adding a plugin to `options.plugins` automatically
 * surfaces its tables in the Cirrus schema — no hand-written table definitions
 * to keep in sync.
 *
 * Spread the result into `defineSchema` alongside your app tables (the keys are
 * better-auth's real table names — `user`, `session`, … — left **unprefixed**
 * because better-auth's adapter addresses them by exactly those names):
 *
 * ```ts
 * import { authTables } from "@cirrus/auth";
 * const authOptions = { emailAndPassword: { enabled: true }, plugins: [organization(), admin()] };
 * export const schema = defineSchema({
 *     ...authTables(authOptions),
 *     todos: defineTable({ title: v.string() }),
 * });
 * ```
 */
const authTables = (options: CirrusAuthOptions): Record<string, TableDefinition> => {
    const tables = getAuthTables(options);
    const schema: Record<string, TableDefinition> = {};

    for (const table of Object.values(tables)) {
        const shape: Record<string, Validator> = {};

        for (const [fieldKey, attribute] of Object.entries(table.fields)) {
            // better-auth lets a field override its stored column via `fieldName`;
            // the adapter reads/writes that name, so the Cirrus column must match.
            shape[attribute.fieldName ?? fieldKey] = fieldValidator(attribute);
        }

        schema[table.modelName] = defineTable(shape);
    }

    return schema;
};

export default authTables;
