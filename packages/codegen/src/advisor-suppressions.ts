/**
 * Inline suppression of one advisor finding, scoped to one rule at one site:
 *
 * ```ts
 * // lunora-advisor-exempt procedure_without_structured_event -- a health probe with nothing to log
 * export const ping = mutation({ ... });
 * ```
 *
 * The directive attaches to the code on the next line that holds code, and it
 * suppresses only findings of the named rule whose `metadata.file`/`metadata.line`
 * fall inside that code. A suppressed finding stays in the advisory list with
 * `suppressed` set, so every surface can show it and its reason. Directives without
 * a rule id are the older whole-procedure exemption and are not handled here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Finding } from "@lunora/advisor";
import { RUNTIME_LINTS, STATIC_LINTS } from "@lunora/advisor";
import type { Project, SourceFile } from "ts-morph";
import { Node, ts } from "ts-morph";

/** A directive line: the word starts a comment line and is not a prefix of a longer token. */
const DIRECTIVE_LINE = /^\s*\/\/\s*lunora-advisor-exempt(?![\w-])(.*)$/u;

/**
 * A rule id at the start of the text after the directive word, followed by a space, `--` or the end. Any
 * letter-led word counts, not only a snake_case one, so a mistyped id (`Unindexed-FK`) is reported invalid
 * instead of falling through to the whole-procedure exemption.
 */
const RULE_ID = /^([a-z][\w-]*)(?=\s|--|$)/iu;

/**
 * The rule id a directive names, or `undefined` for the whole-procedure form.
 * `rest` is the text after the directive word. Pure string scanning, no backtracking
 * regex over untrusted comment text.
 */
const suppressionRuleOf = (rest: string): string | undefined => {
    const body = rest.trimStart();

    if (body.startsWith("--") || body === "") {
        return undefined;
    }

    return RULE_ID.exec(body)?.[1];
};

/**
 * Rules with no source location at all, so a directive for them can never match
 * and is reported as invalid rather than as unused. Plan 596's list.
 */
const LOCATIONLESS_RULES: ReadonlySet<string> = new Set(["notify_missing_push_config"]);

const STATIC_RULES: ReadonlySet<string> = new Set(STATIC_LINTS.map((lint) => lint.name));
const RUNTIME_RULES: ReadonlySet<string> = new Set(RUNTIME_LINTS.map((lint) => lint.name));

interface ParsedDirective {
    /** The file the directive sits in, relative to the project root. */
    display: string;
    /** `file` with the `lunora/` prefix and source extension removed, the form findings are matched on. */
    key: string;
    /** 1-based line of the directive. */
    line: number;
    /** Trimmed text after `--`; empty when the directive gave none. */
    reason: string;
    /** The rule id the directive names. */
    rule: string;
    /** 1-based first and last line of the code the directive attaches to; `undefined` when no code follows. */
    span: { first: number; last: number } | undefined;
    /** For a `wrangler.jsonc` directive, the first `vars` key on the line it attaches to. */
    variable?: string;
}

/** `file` with a leading `lunora/` and a source extension removed, so `shapes`, `shapes.ts` and `lunora/shapes.ts` agree. */
const LUNORA_PREFIX = /^lunora\//u;
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|mts)$/u;

const normaliseFile = (file: string): string => file.replace(LUNORA_PREFIX, "").replace(SOURCE_EXTENSION, "");

/** The wrangler config names, in the order the config reader resolves them. */
const WRANGLER_FILES: ReadonlyArray<string> = ["wrangler.jsonc", "wrangler.json"];

/**
 * The span a `.ts` directive attaches to: the smallest node starting at the next token after the
 * comment, climbed while its parent starts at the same position. The climb stops below the
 * `SourceFile` and any `SyntaxList`, so a directive above a file's first statement attaches to that
 * statement and not to the whole file.
 */
const tsSpanOf = (token: Node): ParsedDirective["span"] => {
    if (token.getKind() === ts.SyntaxKind.EndOfFileToken) {
        return undefined;
    }

    const start = token.getStart();
    let node: Node = token;

    for (;;) {
        const parent: Node | undefined = node.getParent();

        if (parent === undefined || Node.isSourceFile(parent) || Node.isSyntaxList(parent) || parent.getStart() !== start) {
            break;
        }

        node = parent;
    }

    return { first: token.getStartLineNumber(), last: node.getEndLineNumber() };
};

const isCommentNode = (node: Node): boolean =>
    node.getKind() === ts.SyntaxKind.SingleLineCommentTrivia || node.getKind() === ts.SyntaxKind.MultiLineCommentTrivia;

/**
 * The first code token after a `//` comment starting at `offset`, or `undefined` when no line comment
 * starts there, such as text inside a block comment, a string or a template. ts-morph returns a
 * comment that sits between statements as a node of its own, and the next token for one anywhere else.
 */
const tokenAfterLineComment = (sourceFile: SourceFile, offset: number): Node | undefined => {
    const at = sourceFile.getDescendantAtPos(offset) ?? sourceFile.getLastToken();
    let token = at;

    if (isCommentNode(at)) {
        if (at.getKind() !== ts.SyntaxKind.SingleLineCommentTrivia || at.getStart() !== offset) {
            return undefined;
        }

        while (isCommentNode(token)) {
            token = sourceFile.getDescendantAtPos(token.getEnd()) ?? sourceFile.getLastToken();
        }

        return token;
    }

    if (at.getStart() <= offset) {
        return undefined;
    }

    const isLineComment = (ts.getLeadingCommentRanges(sourceFile.getFullText(), at.getPos()) ?? []).some(
        (range) => range.pos === offset && range.kind === ts.SyntaxKind.SingleLineCommentTrivia,
    );

    return isLineComment ? at : undefined;
};

/** Every rule-form directive in one `.ts` source file, with the code it attaches to. */
const tsDirectivesOf = (sourceFile: SourceFile, display: string, key: string): ParsedDirective[] => {
    const lines = sourceFile.getFullText().split("\n");
    const directives: ParsedDirective[] = [];
    let offset = 0;

    lines.forEach((text, index) => {
        const lineOffset = offset;

        offset += text.length + 1;

        const match = DIRECTIVE_LINE.exec(text.trimEnd());
        const rest = match?.[1];

        if (rest === undefined) {
            return;
        }

        const rule = suppressionRuleOf(rest);
        const token = rule === undefined ? undefined : tokenAfterLineComment(sourceFile, lineOffset + text.indexOf("//"));

        if (rule === undefined || token === undefined) {
            return;
        }

        const separator = rest.indexOf("--");
        const reason = separator === -1 ? "" : rest.slice(separator + 2).trim();

        directives.push({ display, key, line: index + 1, reason, rule, span: tsSpanOf(token) });
    });

    return directives;
};

/** Scanner kinds that are whitespace or comments (the public typings do not expose `ts.isTrivia`). */
const TRIVIA_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
    ts.SyntaxKind.ConflictMarkerTrivia,
    ts.SyntaxKind.MultiLineCommentTrivia,
    ts.SyntaxKind.NewLineTrivia,
    ts.SyntaxKind.ShebangTrivia,
    ts.SyntaxKind.SingleLineCommentTrivia,
    ts.SyntaxKind.WhitespaceTrivia,
]);

interface JsoncToken {
    kind: ts.SyntaxKind;
    start: number;
    /** The unquoted text of a string literal. */
    value: string;
}

/**
 * The tokens of a JSONC text that are not whitespace or comments, and where each `//` comment starts. JSONC
 * is lexically a subset of JS, so the TypeScript scanner tells a line comment from the same text inside a
 * block comment or a string, and finds a key however comments are laid out around it.
 */
const scanJsonc = (text: string): { lineComments: ReadonlySet<number>; tokens: ReadonlyArray<JsoncToken> } => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
    const lineComments = new Set<number>();
    const tokens: JsoncToken[] = [];

    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
        if (kind === ts.SyntaxKind.SingleLineCommentTrivia) {
            lineComments.add(scanner.getTokenStart());
        } else if (!TRIVIA_KINDS.has(kind)) {
            tokens.push({ kind, start: scanner.getTokenStart(), value: scanner.getTokenValue() });
        }
    }

    return { lineComments, tokens };
};

/**
 * The first line holding code at or after `offset`, and the key that code opens with: a string followed by `:`.
 * `key` is `undefined` when the code there is not a key (`}`, a value).
 */
const nextKeyOf = (tokens: ReadonlyArray<JsoncToken>, text: string, offset: number): { key: string | undefined; line: number } | undefined => {
    const index = tokens.findIndex((token) => token.start >= offset);
    const token = tokens[index];

    if (token === undefined) {
        return undefined;
    }

    const isKey = token.kind === ts.SyntaxKind.StringLiteral && tokens[index + 1]?.kind === ts.SyntaxKind.ColonToken;

    return { key: isKey ? token.value : undefined, line: text.slice(0, token.start).split("\n").length };
};

/**
 * Every rule-form directive in the wrangler config: a JSONC line comment attaches to the first key on
 * the next line holding one. `.jsonc` wins over `.json`, the order the config reader resolves them in.
 */
const wranglerDirectivesOf = (projectRoot: string): ParsedDirective[] => {
    const name = WRANGLER_FILES.find((candidate) => existsSync(join(projectRoot, candidate)));

    if (name === undefined) {
        return [];
    }

    const source = readFileSync(join(projectRoot, name), "utf8");
    const lines = source.split("\n");
    const directives: ParsedDirective[] = [];
    const { lineComments, tokens } = scanJsonc(source);
    let offset = 0;

    lines.forEach((text, index) => {
        const lineOffset = offset;

        offset += text.length + 1;

        const match = DIRECTIVE_LINE.exec(text.trimEnd());
        const rest = match?.[1];

        if (rest === undefined || !lineComments.has(lineOffset + text.indexOf("//"))) {
            return;
        }

        const rule = suppressionRuleOf(rest);

        if (rule === undefined) {
            return;
        }

        const separator = rest.indexOf("--");
        const reason = separator === -1 ? "" : rest.slice(separator + 2).trim();
        // `offset` is now the start of the next line, so a key written after the directive on its own line is not one.
        const next = nextKeyOf(tokens, source, offset);
        const variable = next?.key;

        directives.push({
            display: name,
            key: name,
            line: index + 1,
            reason,
            rule,
            span: next === undefined ? undefined : { first: next.line, last: next.line },
            ...(variable === undefined ? {} : { variable }),
        });
    });

    return directives;
};

const relativeDisplay = (projectRoot: string, absolute: string): string => relative(projectRoot, absolute).split(sep).join("/");

const metaFinding = (name: string, directive: ParsedDirective, detail: string): Finding => {
    const { display, line, rule } = directive;

    return {
        cacheKey: `${name}:${display}:${line.toString()}`,
        categories: ["SCHEMA"],
        description:
            "An inline `// lunora-advisor-exempt <rule> -- <reason>` directive accepts one advisor finding at the site it sits above. Each directive needs a rule id that can be suppressed and a non-empty reason, and must match a finding, or it does nothing.",
        detail,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { file: display, line, rule },
        name,
        remediation: "Fix the directive so it names a suppressible rule with a reason after `--` and sits directly above the code it accepts, or delete it.",
        title: "Advisor suppression directive does not apply",
    };
};

const spanSize = (directive: ParsedDirective): number => (directive.span === undefined ? Number.POSITIVE_INFINITY : directive.span.last - directive.span.first);

/** The reason a directive cannot suppress anything, or `undefined` when it can. */
const invalidityOf = (directive: ParsedDirective): string | undefined => {
    if (RUNTIME_RULES.has(directive.rule)) {
        return `\`${directive.rule}\` is a runtime lint, which has no source site to suppress.`;
    }

    if (LOCATIONLESS_RULES.has(directive.rule)) {
        return `\`${directive.rule}\` reports no source location, so a directive cannot match it.`;
    }

    if (!STATIC_RULES.has(directive.rule)) {
        return `\`${directive.rule}\` is not a known advisor rule.`;
    }

    if (directive.reason === "") {
        return `The \`${directive.rule}\` directive gives no reason after \`--\`, so it suppresses nothing.`;
    }

    return undefined;
};

/**
 * Mark each finding that a valid directive accepts, and add the two WARN findings for
 * directives that cannot apply or apply to nothing. Runs before the advisor policy, so a finding
 * the severity floor later drops still uses its directive, and the floor applies to the two WARNs
 * as to any other finding. Never runs on a `lint: false` run.
 */
const applySuppressions = (project: Project, projectRoot: string, lunoraDirectory: string, advisories: ReadonlyArray<Finding>): Finding[] => {
    const parsed: ParsedDirective[] = [...wranglerDirectivesOf(projectRoot)];

    // The project holds the `lunora/` tree plus the worker-entry files the security lints scan
    // (`listSecurityScanFiles`). Findings name every file relative to `lunora/`, a worker entry as
    // `../src/worker`, so a root file never shares a key with a `lunora/` file of the same path.
    for (const sourceFile of project.getSourceFiles()) {
        const absolute = sourceFile.getFilePath();
        const inside = relative(lunoraDirectory, absolute).split(sep).join("/");
        const display = relativeDisplay(projectRoot, absolute);
        const isLunora = inside !== "" && !inside.startsWith("..");

        if (isLunora || (!display.startsWith("..") && !display.split("/").includes("node_modules") && !sourceFile.isDeclarationFile())) {
            parsed.push(...tsDirectivesOf(sourceFile, display, normaliseFile(inside)));
        }
    }

    const valid: ParsedDirective[] = [];
    const meta: Finding[] = [];

    for (const directive of parsed) {
        const invalid = invalidityOf(directive);

        if (invalid === undefined) {
            valid.push(directive);
        } else {
            meta.push(metaFinding("advisor_suppression_invalid", directive, invalid));
        }
    }

    const used = new Set<ParsedDirective>();

    const marked = advisories.map((finding): Finding => {
        if (finding.suppressed !== undefined) {
            return finding;
        }

        const { file, key, line } = finding.metadata;

        if (typeof file !== "string" || typeof line !== "number") {
            return finding;
        }

        // The innermost directive is the one written for this finding; an enclosing one of the same rule
        // stays free to match something else, or is reported unused.
        const [match] = valid
            .filter(
                (directive) =>
                    directive.rule === finding.name &&
                    directive.key === normaliseFile(file) &&
                    directive.span !== undefined &&
                    // A wrangler directive whose key could not be read accepts nothing rather than every key on its line.
                    (!WRANGLER_FILES.includes(directive.key) || directive.variable === key) &&
                    directive.span.first <= line &&
                    line <= directive.span.last,
            )
            .toSorted((left, right) => spanSize(left) - spanSize(right));

        if (match === undefined) {
            return finding;
        }

        used.add(match);

        return { ...finding, suppressed: { file: match.display, line: match.line, reason: match.reason } };
    });

    for (const directive of valid) {
        if (!used.has(directive)) {
            meta.push(
                metaFinding(
                    "advisor_suppression_unused",
                    directive,
                    `The \`${directive.rule}\` directive suppresses no finding: nothing of that rule is reported on the code below it.`,
                ),
            );
        }
    }

    return [...marked, ...meta];
};

export { applySuppressions, suppressionRuleOf };
