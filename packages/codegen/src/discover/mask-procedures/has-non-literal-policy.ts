import type { Node as TsNode, ObjectLiteralExpression, Project } from "ts-morph";
import { Node } from "ts-morph";

import { listLunoraSourceFiles } from "../ast";
import exportedProcedureChains from "../functions/exported-procedure-chains";
import { maskCallsInChain } from "./internal/mask-call";

/**
 * True when `member` has a name `memberName` would resolve, but the name
 * is COMPUTED (`[expr]: …`) rather than a plain identifier/string/numeric
 * literal — e.g. `mask({ [tableName]: { email: "redact" } })`. Whether
 * ts-morph's `getName()` renders the bracketed source text or throws for such
 * a member, neither is a table/column name codegen can trust enumerating
 * against, so this is checked independently of `memberName` rather than
 * relying on it returning `undefined`. Covers every member kind `memberName`
 * accepts except `ShorthandPropertyAssignment`, which can't have a computed
 * name by grammar.
 */
const hasComputedName = (member: TsNode): boolean => {
    if (Node.isPropertyAssignment(member) || Node.isMethodDeclaration(member) || Node.isGetAccessorDeclaration(member)) {
        return Node.isComputedPropertyName(member.getNameNode());
    }

    return false;
};

/**
 * True when `member` is something `memberName` can't turn into a usable
 * table/column name — mirrors `memberName`'s accepted-kinds list BY
 * CONSTRUCTION rather than enumerating specific unsupported kinds by name:
 * anything that isn't one of the four kinds `memberName` accepts
 * (`PropertyAssignment`, `ShorthandPropertyAssignment`, `MethodDeclaration`,
 * `GetAccessorDeclaration`) is unnameable — this covers `SpreadAssignment`,
 * `SetAccessorDeclaration`, and any other object-literal member kind
 * ts-morph exposes now or later, matching exactly what the extractors'
 * `memberName(...) === undefined` skip already treats as unenumerable. Among
 * the four accepted kinds, a COMPUTED name is unnameable too even though
 * `memberName` resolves some text for it (see {@link hasComputedName}).
 */
const isUnnameableMember = (member: TsNode): boolean => {
    if (
        Node.isPropertyAssignment(member) ||
        Node.isShorthandPropertyAssignment(member) ||
        Node.isMethodDeclaration(member) ||
        Node.isGetAccessorDeclaration(member)
    ) {
        return hasComputedName(member);
    }

    return true;
};

/**
 * True when `object` — a `mask(...)` policies literal — has a member
 * `extractMaskColumns` can't enumerate, checked at the table level and,
 * for each table entry that IS enumerable, ONE further level at the column
 * level. This is exactly the two-level table→column walk
 * `extractMaskColumns`/`extractMaskColumnMetadata` perform — NOT
 * unbounded recursion, and NOT the same test at both levels.
 *
 * Table level applies {@link isUnnameableMember} plus a stricter shape check:
 * the extractor's table loop requires the entry to be a plain property
 * assignment (a shorthand, method, or get-accessor table entry — e.g.
 * `{ users }` referencing a variable — is skipped there even though
 * `memberName` can name it) whose value is a bare object literal; an
 * identifier reference (`{ users: piiColumns }`), an `as const`/`satisfies`
 * wrapper, or a call expression all fail that shape check and are treated as
 * unnameable, matching the extractor's fall-through-and-skip.
 *
 * Column level (recursed one level in, `atColumnLevel: true`) applies only
 * {@link isUnnameableMember} — a column's value is a STRATEGY, not required
 * to be an object literal. `strategyOf` labels any non-string-literal
 * strategy `"custom"` without needing to enumerate inside it, so column
 * values are never shape-checked or recursed into further. A legitimately
 * nested object at that depth — e.g.
 * `mask({ users: { ssn: { kind: "custom", ...opts } } })`, a fully literal
 * and fully enumerable table/column pair — is therefore NOT a fail-open the
 * extractors miss, and flagging it would be a false positive (recursing past
 * the column level was an earlier bug here).
 */
const objectLiteralHasUnnameableMember = (object: ObjectLiteralExpression, atColumnLevel = false): boolean => {
    for (const property of object.getProperties()) {
        if (isUnnameableMember(property)) {
            return true;
        }

        if (atColumnLevel) {
            continue;
        }

        if (!Node.isPropertyAssignment(property)) {
            return true;
        }

        const initializer = property.getInitializer();

        if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
            return true;
        }

        if (objectLiteralHasUnnameableMember(initializer, true)) {
            return true;
        }
    }

    return false;
};

/**
 * True when the project declares at least one `mask(...)` call whose policies
 * argument IS PRESENT but isn't a plain object literal — e.g. a hoisted
 * `mask(sharedPolicies)` — OR is an object literal that contains a spread or
 * computed key (see {@link objectLiteralHasUnnameableMember}) at either the
 * table or the column level — e.g. `mask({ ...sharedPolicies })`,
 * `mask({ [tableName]: { email: "redact" } })`, or
 * `mask({ users: { ...piiColumns } })`. `extractMaskColumns`/
 * `extractMaskColumnMetadata` silently contribute `[]` (or an
 * incomplete column list) for all of these — a variable reference, a spread,
 * or a computed key can't be statically enumerated — so every masked-column
 * consumer derived from `discoverMaskMetadata` is blind to whichever
 * table(s)/column(s) the call actually masks. `assertNoMaskedShapeTable` (in
 * `run-codegen.ts`) uses this to fail closed rather than clear a `defineShape`
 * it can't actually prove safe.
 *
 * Deliberately kept OUT of `MaskMetadataIR` — that IR is JSON-embedded
 * verbatim into the generated `LUNORA_MASK_METADATA` literal and type-checked
 * against `@lunora/do`'s hand-mirrored `MaskPoliciesResult`; adding a field
 * here would embed it in that literal and trip the generated file's
 * excess-property check under strict TS. This stays a standalone signal
 * consumed only by the codegen-time guard, never emitted.
 */
const discoverMaskHasNonLiteralPolicy = (project: Project, lunoraDirectory: string): boolean => {
    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const { receiver } of exportedProcedureChains(sourceFile)) {
            for (const maskCall of maskCallsInChain(receiver)) {
                const argument = maskCall.getArguments()[0];

                if (argument !== undefined && (!Node.isObjectLiteralExpression(argument) || objectLiteralHasUnnameableMember(argument))) {
                    return true;
                }
            }
        }
    }

    return false;
};

export default discoverMaskHasNonLiteralPolicy;
