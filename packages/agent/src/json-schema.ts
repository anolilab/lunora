import type { jsonSchema as providerJsonSchema, Schema, ValidationResult } from "@ai-sdk/provider-utils";

/**
 * The marker the AI SDK looks for to tell a ready-made schema from a raw zod or standard one. It is
 * `Symbol.for`, so a schema made here is recognised by whichever copy of the SDK ends up reading it;
 * `__tests__/json-schema.test.ts` pins this module against the SDK's own `jsonSchema`.
 */
const SCHEMA_MARKER = Symbol.for("vercel.ai.schema");

/**
 * `jsonSchema` from `@ai-sdk/provider-utils`, built without importing it. That package's root
 * evaluates zod (about a hundred modules) as soon as anything is imported from it, and every
 * tool module here builds a schema at module scope, so the root import put zod in every Worker's
 * startup graph that wires an agent. A schema is a plain object, so the agent builds its own; the
 * SDK itself is only imported where a zod schema has to be converted (`code-tool`).
 */
const jsonSchema = <OBJECT = unknown>(
    schema: Parameters<typeof providerJsonSchema>[0],
    { validate }: { validate?: (value: unknown) => PromiseLike<ValidationResult<OBJECT>> | ValidationResult<OBJECT> } = {},
): Schema<OBJECT> => {
    let resolved = schema;

    return {
        [SCHEMA_MARKER]: true,
        _type: undefined,
        get jsonSchema() {
            if (typeof resolved === "function") {
                resolved = resolved();
            }

            return resolved;
        },
        validate,
        // The SDK's `Schema` types its marker as an unexported `unique symbol`, which no value can be typed as.
    } as unknown as Schema<OBJECT>;
};

export default jsonSchema;
