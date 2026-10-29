import type { Schema } from "@ai-sdk/provider-utils";

/**
 * The AI SDK's `jsonSchema()`, without importing `@ai-sdk/provider-utils`.
 *
 * That package's single entry statically imports `zod/v4` (~830 KiB), so one
 * `jsonSchema` import from a tool factory or `defineAgent` put zod into every
 * agent Worker's startup graph, though only the lazily loaded loop needs it.
 * The SDK recognises a schema purely structurally (`isSchema`: the registered
 * `vercel.ai.schema` symbol plus `jsonSchema` and `validate` keys), so this
 * object is accepted wherever the SDK's own is; a test pins that against the
 * real `asSchema`.
 */
const jsonSchema = <OBJECT = unknown>(schema: Awaited<Schema["jsonSchema"]>): Schema<OBJECT> =>
    ({
        [Symbol.for("vercel.ai.schema")]: true,
        _type: undefined,
        jsonSchema: schema,
        validate: undefined,
    }) as unknown as Schema<OBJECT>;

export default jsonSchema;
