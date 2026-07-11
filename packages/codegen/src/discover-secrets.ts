import type { Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { SecretLiteralIR } from "./ir";
import { redact, secretKindOf } from "./secret-rules";

/**
 * The constant string value of a node, folding `+` concatenations of string
 * literals (`"a" + "b" + "c"` → `"abc"`) so a secret split across adjacent
 * literals is scanned as one token. Returns `undefined` for non-string nodes or a
 * concatenation that mixes in a non-literal operand (the dynamic part defeats a
 * static value). String-literal and no-substitution-template leaves resolve to
 * their text; a `+` binary expression resolves to the join of its two sides.
 */
const literalValueOf = (node: TsNode): string | undefined => {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        return node.getLiteralText();
    }

    if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
        const left = literalValueOf(node.getLeft());
        const right = literalValueOf(node.getRight());

        return left !== undefined && right !== undefined ? left + right : undefined;
    }

    return undefined;
};

/**
 * True when `node` is an operand of an enclosing `+` concatenation whose topmost
 * `+` root folds to a defined value — i.e. the whole concatenation is static and
 * already reported at that root, so the operand is safely skipped here. When the
 * top-level `+` root mixes in a dynamic operand it folds to `undefined` (see
 * `literalValueOf`) and is dropped, so this returns `false` and the fully-formed
 * literal operand (e.g. a complete `"sk_live_…"` prefix in `SECRET + suffix`) is
 * scanned individually instead of being silently lost.
 */
const isFoldedConcatenationOperand = (node: TsNode): boolean => {
    let root = node;
    let parent = root.getParent();

    while (parent !== undefined && Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
        root = parent;
        parent = root.getParent();
    }

    return root !== node && literalValueOf(root) !== undefined;
};

/** Secret-shaped string literals (and `+`-folded concatenations) in one source file. */
const secretsInSourceFile = (sourceFile: SourceFile, relativePath: string): SecretLiteralIR[] => {
    const found: SecretLiteralIR[] = [];

    const nodes: TsNode[] = [
        // Top-level `+` concatenations are folded; their string-literal operands are
        // skipped below so a secret split across literals is reported once, at the root.
        ...sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral),
        ...sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ];

    // Dedupe by (line, kind): a secret split across literals AND carrying a
    // dynamic tail (`"sk_live_…" + "tail" + x`) can now be matched both by an
    // inner static sub-binary that folds and by the individually-scanned leaf,
    // which would otherwise emit two rows for the same finding.
    const seen = new Set<string>();

    for (const node of nodes) {
        if (isFoldedConcatenationOperand(node)) {
            continue;
        }

        const value = literalValueOf(node);

        if (value === undefined) {
            continue;
        }

        const kind = secretKindOf(value);

        if (kind === undefined) {
            continue;
        }

        const line = node.getStartLineNumber();
        const dedupeKey = `${String(line)}:${kind}`;

        if (seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);
        found.push({ file: relativePath, kind, line, preview: redact(value) });
    }

    return found;
};

/**
 * Discover secret-shaped string literals (`sk_live_…`, `AKIA…`, `ghp_…`, PEM
 * private-key headers, mixed-charset high-entropy runs, and long single-case hex
 * keys) in every `.ts` file under the lunora source directory — the
 * `hardcoded_secret` lint input. Adjacent `+`-concatenated string literals are
 * folded so a secret split across pieces is still scanned as one token. A secret
 * checked into source belongs in `.dev.vars` / `wrangler secret put`, never the
 * codebase. Complements the pre-commit `vis secrets` gate by surfacing the same
 * class of finding in the studio Advisors table at codegen time.
 */
const discoverSecrets = (project: Project, lunoraDirectory: string): SecretLiteralIR[] => {
    const secrets: SecretLiteralIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        secrets.push(...secretsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return secrets;
};

export default discoverSecrets;
