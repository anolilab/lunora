import type { Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { SecretLiteralIR } from "./ir";

/** A long, contiguous base64/hex run (length floor 40 so UUIDs/identifiers don't trip it). */
const HIGH_ENTROPY_TOKEN_RE = /[\w+/=-]{40,}/u;
/** The three character classes a high-entropy token must mix to count as key-like. */
const LOWER_RE = /[a-z]/u;
const UPPER_RE = /[A-Z]/u;
const DIGIT_RE = /\d/u;

/**
 * A long, contiguous single-case hex run (32+ chars) — a raw hex-encoded key /
 * HMAC secret. The mixed-charset {@link isHighEntropy} rule misses these because
 * an all-lowercase (or all-uppercase) hex token has no second character class.
 * The `{32,}` floor (128-bit hex and up) keeps UUIDs-without-dashes and short
 * digests out of scope while still catching 64-char (256-bit) keys.
 */
const HEX_SECRET_RE = /\b(?:[\da-f]{32,}|[\dA-F]{32,})\b/u;

/** Charset-diversity floor for the generic high-entropy rule — must mix lower, upper, and digit. */
const isHighEntropy = (value: string): boolean => {
    // A long, contiguous base64/hex run with at least three character classes is
    // far more likely a key than prose.
    const token = HIGH_ENTROPY_TOKEN_RE.exec(value)?.[0];

    if (token === undefined) {
        return false;
    }

    return LOWER_RE.test(token) && UPPER_RE.test(token) && DIGIT_RE.test(token);
};

/** A long single-case hex token — catches lowercase/uppercase-only keys the mixed-charset rule skips. */
const isHexSecret = (value: string): boolean => HEX_SECRET_RE.test(value);

/** Provider-specific secret-literal matchers, hoisted to module scope (no per-call recompilation). */
const STRIPE_LIVE_KEY_RE = /\b(?:sk|rk)_live_[\dA-Za-z]{20,}/u;
const AWS_ACCESS_KEY_RE = /\bAKIA[\dA-Z]{16}\b/u;
const GITHUB_TOKEN_RE = /\bgh[posru]_[\dA-Za-z]{36,}/u;
const OPENAI_KEY_RE = /\bsk-[\dA-Za-z]{32,}/u;
const SLACK_TOKEN_RE = /\bxox[abprs]-[\dA-Za-z-]{10,}/u;
const PRIVATE_KEY_RE = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/u;

/**
 * Secret-shaped literal heuristics, in priority order. Each maps a `kind` label
 * (surfaced in the finding) to a matcher over a string-literal value. Mirrors the
 * gitleaks-style rules the pre-commit `vis secrets` scan applies, narrowed to the
 * highest-signal providers so the in-IDE advisor stays low-noise.
 */
const SECRET_RULES: ReadonlyArray<{ kind: string; test: (value: string) => boolean }> = [
    { kind: "stripe_live_key", test: (value) => STRIPE_LIVE_KEY_RE.test(value) },
    { kind: "aws_access_key", test: (value) => AWS_ACCESS_KEY_RE.test(value) },
    { kind: "github_token", test: (value) => GITHUB_TOKEN_RE.test(value) },
    { kind: "openai_key", test: (value) => OPENAI_KEY_RE.test(value) },
    { kind: "slack_token", test: (value) => SLACK_TOKEN_RE.test(value) },
    { kind: "private_key", test: (value) => PRIVATE_KEY_RE.test(value) },
    { kind: "high_entropy", test: isHighEntropy },
    { kind: "hex_secret", test: isHexSecret },
];

/** The matching secret rule's `kind` for a string value, or `undefined` when none matches. */
const secretKindOf = (value: string): string | undefined => SECRET_RULES.find((rule) => rule.test(value))?.kind;

/** A redacted preview of a secret literal — first 4 chars plus its length, never the full value. */
const redact = (value: string): string => `${value.slice(0, 4)}…(${String(value.length)} chars)`;

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

/** True when `node` is an operand of an enclosing `+` string-concatenation — folded by its root, so skip here. */
const isConcatenationOperand = (node: TsNode): boolean => {
    const parent = node.getParent();

    return parent !== undefined && Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.PlusToken;
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

    for (const node of nodes) {
        if (isConcatenationOperand(node)) {
            continue;
        }

        const value = literalValueOf(node);

        if (value === undefined) {
            continue;
        }

        const kind = secretKindOf(value);

        if (kind !== undefined) {
            found.push({ file: relativePath, kind, line: node.getStartLineNumber(), preview: redact(value) });
        }
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
