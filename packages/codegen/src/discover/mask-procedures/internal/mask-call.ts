import type { CallExpression, Node as TsNode } from "ts-morph";
import { Node } from "ts-morph";

import type { MaskColumnMetadataIR } from "../../../ir";
import { wrappedCallsInChain } from "../../builder-chain";
import { resolvesToImportedName } from "../../callee";

/**
 * True when `node` is a `CallExpression` whose callee resolves to the name
 * `"mask"` — a bare identifier (`mask(policies)`), a property access
 * (`maskModule.mask(policies)`), or an import alias (`import { mask as hide }`
 * called as `hide(policies)`). Matched by name (not import origin) so the check
 * is robust even when ts-morph has degraded type info — exactly the discipline
 * `discover/rls-procedures` uses for `rls`, and it shares the same helper.
 */
const isMaskCall = (node: TsNode): boolean => {
    if (!Node.isCallExpression(node)) {
        return false;
    }

    return resolvesToImportedName(node.getExpression(), "mask");
};

/**
 * The declared name of an object-literal member (`email: …`, `email() {}`,
 * `email`), or `undefined` for a member kind that has no static name.
 *
 * A string-literal key is read through its literal VALUE, not `getName()`.
 * `getName()` renders the name node's source text, so `mask({ "users": … })`
 * came back as `"users"` with the quote characters attached — a table name that
 * matches nothing. That is not cosmetic: `assertNoMaskedShapeTable` keys its
 * masked-column map on this string and looks it up by `ShapeIR.table`, which is
 * always unquoted, so the lookup missed and the fail-closed guard let a
 * `defineShape` replicating a masked column through. `LUNORA_MASK_METADATA` and
 * the PII strategy lint keyed off the same string and missed for the same
 * reason. Quoting a key is ordinary TypeScript, so nothing warned.
 *
 * A COMPUTED key still resolves to its bracketed source text rather than
 * `undefined` — deliberate, and `hasComputedName` in `has-non-literal-policy`
 * rejects those independently rather than relying on this returning `undefined`.
 */
const memberName = (member: TsNode): string | undefined => {
    if (
        !Node.isPropertyAssignment(member) &&
        !Node.isShorthandPropertyAssignment(member) &&
        !Node.isMethodDeclaration(member) &&
        !Node.isGetAccessorDeclaration(member)
    ) {
        return undefined;
    }

    const nameNode = member.getNameNode();

    return Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : member.getName();
};

/**
 * Every `mask(...)` call carried through a `.use(mask(...))` step of the builder
 * chain rooted at `receiver`, terminal-first. Shares the chain walk with the RLS
 * twin and with `chainUsesWrappedCall`, so all three agree on aliases and on
 * seeing through a `(…)` / `as T` wrapper mid-chain.
 */
const maskCallsInChain = (receiver: TsNode): CallExpression[] => wrappedCallsInChain(receiver, "use", "mask");

/**
 * The masking strategy declared for one column property. A string-literal
 * initializer of `"redact"`/`"hash"` maps to that strategy; anything else (a
 * `(value, ctx) => …` function, a shorthand/method member, or a non-literal
 * reference) is `"custom"` — fail-closed: the studio preview renders a fixed
 * sentinel rather than guessing the closure's output.
 */
const strategyOf = (columnProperty: TsNode): MaskColumnMetadataIR["strategy"] => {
    if (Node.isPropertyAssignment(columnProperty)) {
        const initializer = columnProperty.getInitializer();

        if (initializer && Node.isStringLiteral(initializer)) {
            const literal = initializer.getLiteralText();

            if (literal === "redact" || literal === "hash") {
                return literal;
            }
        }
    }

    return "custom";
};

export { isMaskCall, maskCallsInChain, memberName, strategyOf };
