/**
 * Which `@lunora/agent` sandbox tools a source file imports — the half of
 * binding inference that mirrors codegen's `discover/sandbox.ts` rather than a
 * package import. `browserTool` provisions `BROWSER`; `jsCodeTool` provisions
 * `LOADER`.
 */
import { parse as lexModule } from "es-module-lexer";

import { escapeRegExp } from "./dev-variables-format";

const TYPE_ONLY_IMPORT_PATTERN = /^\s*import\s+type\b/;

/**
 * The specifiers the sandbox tools are imported from — mirrors
 * `discover/sandbox.ts`'s identical constant exactly (both the main entry and
 * the `/sandbox` subpath re-export every tool).
 */
const SANDBOX_MODULE_SPECIFIERS = new Set(["@lunora/agent", "@lunora/agent/sandbox"]);

/** The sandbox tools whose import implies a binding. */
const SANDBOX_TOOLS = ["browserTool", "jsCodeTool"] as const;

type SandboxToolName = (typeof SANDBOX_TOOLS)[number];

/**
 * Per tool: its name in an extracted specifier list, a specifier-level
 * `{ type <tool> }` inside an otherwise-value import (compiles away, mirroring
 * `discover/sandbox.ts`'s `named.isTypeOnly()` guard), and the whole-file
 * fallback used ONLY when `es-module-lexer` can't parse the file (e.g.
 * mid-edit) — same degrade-gracefully contract as `capabilitiesFromSource`'s
 * lexer/regex split, and the same comment-blindness every other capability's
 * regex fallback has.
 */
const TOOL_PATTERNS = Object.fromEntries(
    SANDBOX_TOOLS.map((tool) => {
        const name = escapeRegExp(tool);

        return [
            tool,
            {
                fallback: new RegExp(String.raw`import\s+\{[^}]*\b${name}\b[^}]*\}\s+from\s+["']@lunora\/agent(?:\/sandbox)?["']`, "u"),
                name: new RegExp(String.raw`\b${name}\b`, "u"),
                typeSpecifier: new RegExp(String.raw`\btype\s+${name}\b`, "u"),
            },
        ];
    }),
) as Record<SandboxToolName, { fallback: RegExp; name: RegExp; typeSpecifier: RegExp }>;

/**
 * Extracts the specifier list between the FIRST `{` and its matching `}` in
 * an import declaration's sliced text via plain index scans (not a regex),
 * so each tool check scans that single bounded slice once instead of two
 * overlapping `[^}]*` quantifiers around a shared anchor — the
 * super-linear-backtracking shape `sonarjs/slow-regex` flags.
 */
const extractImportSpecifierList = (statementText: string): string => {
    const openBraceIndex = statementText.indexOf("{");

    if (openBraceIndex === -1) {
        return "";
    }

    const closeBraceIndex = statementText.indexOf("}", openBraceIndex + 1);

    return closeBraceIndex === -1 ? statementText.slice(openBraceIndex + 1) : statementText.slice(openBraceIndex + 1, closeBraceIndex);
};

/**
 * True when the sliced text of a SINGLE import declaration is a VALUE
 * (non-type-only) named import of `tool` — mirrors `discover/sandbox.ts`'s
 * `declaration.isTypeOnly()` (whole import) and `named.isTypeOnly()` (single
 * specifier) guards exactly.
 */
const isValueToolImport = (statementText: string, tool: SandboxToolName): boolean => {
    if (TYPE_ONLY_IMPORT_PATTERN.test(statementText)) {
        return false; // `import type { browserTool } from …` — the whole import compiles away.
    }

    const specifierList = extractImportSpecifierList(statementText);

    return TOOL_PATTERNS[tool].name.test(specifierList) && !TOOL_PATTERNS[tool].typeSpecifier.test(specifierList);
};

/**
 * Which sandbox tools `code` VALUE-imports from `@lunora/agent` (main entry or
 * `/sandbox`). Walks `es-module-lexer`'s PARSED import records and tests only
 * the sliced text of each matching declaration — a commented-out import is
 * never parsed as a declaration, so it can never match, and a `type`-prefixed
 * specifier is rejected by {@link isValueToolImport}. This is what makes the
 * detector agree with `discover/sandbox.ts`'s AST-based one on the same
 * fixture matrix. The lexer must be initialised by the caller.
 */
const sandboxToolImports = (code: string): Record<SandboxToolName, boolean> => {
    let statements: string[] | undefined;

    try {
        const [imports] = lexModule(code);

        statements = imports.filter((entry) => entry.n !== undefined && SANDBOX_MODULE_SPECIFIERS.has(entry.n)).map((entry) => code.slice(entry.ss, entry.se));
    } catch {
        statements = undefined;
    }

    return Object.fromEntries(
        SANDBOX_TOOLS.map((tool) => [
            tool,
            statements === undefined ? TOOL_PATTERNS[tool].fallback.test(code) : statements.some((statement) => isValueToolImport(statement, tool)),
        ]),
    ) as Record<SandboxToolName, boolean>;
};

export type { SandboxToolName };
export { extractImportSpecifierList, SANDBOX_TOOLS, sandboxToolImports, TYPE_ONLY_IMPORT_PATTERN };
