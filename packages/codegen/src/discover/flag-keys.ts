import type { CallExpression, Project, PropertyAccessExpression } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isContextIdentifier, listLunoraSourceFiles } from "./ast";

/** The four typed flag reads `ctx.flags.<type>(…)` / `ctx.flags.details.<type>(…)` expose. */
const FLAG_TYPES = new Set(["boolean", "number", "object", "string"]);

/** One statically-discovered flag read: the key plus the value type its `ctx.flags.<type>` call implies. */
interface FlagKey {
    /** The flag key — the first (string-literal) argument of the `ctx.flags.<type>(…)` read. */
    key: string;
    /** The value type, derived from which `ctx.flags.<type>` method read it. */
    type: "boolean" | "number" | "object" | "string";
}

/**
 * Decide whether `access` is a `ctx.flags.<type>` or `ctx.flags.details.<type>`
 * property access and, if so, return the value type. Anchored on a literal `ctx`
 * identifier (the destructured `const { flags } = ctx` form isn't matched — like
 * the studio nav probe, a bare `flags.boolean(...)` is too ambiguous to claim).
 */
const flagTypeFromAccess = (access: PropertyAccessExpression): FlagKey["type"] | undefined => {
    const name = access.getName();

    if (!FLAG_TYPES.has(name)) {
        return undefined;
    }

    const receiver = access.getExpression();

    if (!Node.isPropertyAccessExpression(receiver)) {
        return undefined;
    }

    // `ctx.flags.<type>(...)`
    if (receiver.getName() === "flags" && isContextIdentifier(receiver.getExpression())) {
        return name as FlagKey["type"];
    }

    // `ctx.flags.details.<type>(...)`
    const inner = receiver.getExpression();

    if (
        receiver.getName() === "details" &&
        Node.isPropertyAccessExpression(inner) &&
        inner.getName() === "flags" &&
        isContextIdentifier(inner.getExpression())
    ) {
        return name as FlagKey["type"];
    }

    return undefined;
};

/**
 * Statically discover every feature flag the app's `lunora/` handlers read, by
 * scanning for `ctx.flags.<type>("key", …)` (and `ctx.flags.details.<type>(…)`)
 * calls whose first argument is a string literal. Powers the studio's read-only
 * Flags page (`__lunora_admin__:listFlags`) and the generated `evaluateFlags`
 * override, which evaluates each discovered key through the configured provider.
 *
 * Best-effort: only literal keys behind a literal `ctx` receiver are captured (a
 * dynamic key or a destructured `flags` binding is skipped — the page simply
 * won't list it). Keys are de-duplicated (first read wins on a type clash) and
 * returned sorted by key for deterministic codegen output.
 */
/** Extract the `{ key, type }` of a single `ctx.flags.<type>("key", …)` read, or `undefined` when the call isn't one. */
const flagKeyFromCall = (call: CallExpression): FlagKey | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const type = flagTypeFromAccess(callee);

    if (type === undefined) {
        return undefined;
    }

    const argument = call.getArguments()[0];

    if (!argument || !(Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))) {
        return undefined;
    }

    const key = argument.getLiteralValue();

    return key.length > 0 ? { key, type } : undefined;
};

const discoverFlagKeys = (project: Project, lunoraDirectory: string): FlagKey[] => {
    const found = new Map<string, FlagKey["type"]>();

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const candidate = flagKeyFromCall(call);

            if (candidate && !found.has(candidate.key)) {
                found.set(candidate.key, candidate.type);
            }
        }
    }

    return [...found.entries()]
        .map(([key, type]) => {
            return { key, type };
        })
        .toSorted((a, b) => a.key.localeCompare(b.key));
};

export { discoverFlagKeys };
export type { FlagKey };
