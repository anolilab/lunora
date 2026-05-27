# @cirrus/values

The `v` validator namespace for the Cirrus framework. A small, Convex-inspired runtime + type system that doubles as a schema descriptor for codegen.

Every validator carries a runtime `parse` / `safeParse` plus a phantom `__type` field that `Infer<…>` reads to recover the TS type. Codegen ([`@cirrus/codegen`](../codegen)) inspects the `kind` tag to render `dataModel.ts` and the typed `api.ts`.

## Install

```bash
pnpm add @cirrus/values
```

No workspace dependencies. Usually consumed transitively via [`@cirrus/server`](../server), which re-exports `v`.

## Usage

```ts
import { v, type Infer } from "@cirrus/values";

const Message = v.object({
    id: v.id("messages"),
    room: v.string(),
    body: v.string(),
    ts: v.number(),
    edited: v.optional(v.boolean()),
    reactions: v.record(v.string(), v.number()),
    status: v.union(v.literal("draft"), v.literal("sent"), v.literal("failed")),
    attachments: v.array(v.string()),
});

type Message = Infer<typeof Message>;
// {
//   id: Id<"messages">;
//   room: string;
//   body: string;
//   ts: number;
//   edited?: boolean;
//   reactions: Record<string, number>;
//   status: "draft" | "sent" | "failed";
//   attachments: string[];
// }

// Throw on mismatch:
const parsed = Message.parse(input);

// Or branch on the result:
const result = Message.safeParse(input);
if (!result.ok) console.error(result.error.path, result.error.expected);
```

## Validator catalogue

| Factory             | Parses                                                            | TS type                           |
| ------------------- | ----------------------------------------------------------------- | --------------------------------- |
| `v.string()`        | `typeof value === "string"`                                       | `string`                          |
| `v.number()`        | `typeof value === "number" && !isNaN`                             | `number`                          |
| `v.boolean()`       | `typeof value === "boolean"`                                      | `boolean`                         |
| `v.bigint()`        | `typeof value === "bigint"`                                       | `bigint`                          |
| `v.null()`          | `value === null`                                                  | `null`                            |
| `v.bytes()`         | `value instanceof ArrayBuffer`                                    | `ArrayBuffer`                     |
| `v.any()`           | anything                                                          | `unknown`                         |
| `v.id("table")`     | string (branded by table name)                                    | `Id<"table">`                     |
| `v.literal(value)`  | `===` against `value` (string/number/boolean/null/bigint)         | the literal type                  |
| `v.array(inner)`    | array, recursively parses each item                               | `Array<Infer<inner>>`             |
| `v.object({ … })`   | object, recursively parses each field                             | inferred object shape             |
| `v.record(k, v)`    | object, parses each key + each value                              | `Record<Infer<k>, Infer<v>>`      |
| `v.union(a, b, …)`  | first member that `safeParse` accepts                             | `Infer<a> \| Infer<b> \| …`       |
| `v.optional(inner)` | `value === undefined` short-circuits, else delegates              | `Infer<inner> \| undefined`       |

`v.object` follows the same convention as TS itself: keys whose validator includes `undefined` (i.e. wrapped in `v.optional`) are made optional via `?:` in the inferred type.

## Branded ids

```ts
import { v, type Id, type Infer } from "@cirrus/values";

const validator = v.id("messages");
type MessageId = Infer<typeof validator>; // Id<"messages">

declare const userId: Id<"users">;
declare const messageId: Id<"messages">;

const wrong: MessageId = userId; // Compile error — Id<"users"> ≠ Id<"messages">
```

At runtime the branded type is just `string`; the brand exists only in the type system to prevent cross-table id mixups.

## API

| Export             | Description                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `v`                | Validator factory namespace (all entries above).                                         |
| `Infer<V>`         | Type helper — extracts the TS type a validator describes.                                |
| `Id<TableName>`    | Branded string type for table ids.                                                       |
| `ValidationError`  | Thrown by `parse`. Carries `path`, `expected`, `received`.                               |
| `describeValue`    | Stringify a runtime value for human-readable errors.                                     |
| `formatPath`       | Format a `ValidationPath` (e.g. `messages[3].body`).                                     |

Types: `Validator<T>`, `ValidatorKind`, `ValidationPath`.

## Docs

- Repo root: [README.md](../../README.md)
- Schema concepts: [apps/docs/content/docs/concepts/schema.mdx](../../apps/docs/content/docs/concepts/schema.mdx)
- Server reference: [apps/docs/content/docs/api/server.mdx](../../apps/docs/content/docs/api/server.mdx)

## License

MIT — see [LICENSE.md](../../LICENSE.md)
