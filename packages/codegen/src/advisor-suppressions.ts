/**
 * Inline suppression of one advisor finding, scoped to one rule at one site:
 *
 * ```ts
 * // lunora-advisor-exempt unindexed_foreign_key -- the parent table is append-only
 * export const audit = mutation({ ... });
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
import { Node } from "ts-morph";

/** A directive line: the word starts a comment line and is not a prefix of a longer token. */
const DIRECTIVE_LINE = /^\s*\/\/\s*lunora-advisor-exempt(?![\w-])(.*)$/u;

/** A snake_case rule id at the start of the text after the directive word, followed by a space, `--` or the end. */
const RULE_ID = /^([a-z][a-z0-9_]*)(?=\s|--|$)/u;

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
}

/** `file` with a leading `lunora/` and a source extension removed, so `shapes`, `shapes.ts` and `lunora/shapes.ts` agree. */
const LUNORA_PREFIX = /^lunora\//u;
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|mts)$/u;
const BLOCK_COMMENT_BODY = /^\*(?:\s|$)/u;

const normaliseFile = (file: string): string => file.replace(LUNORA_PREFIX, "").replace(SOURCE_EXTENSION, "");

/** A line that holds no code: blank, a line comment, or a block comment's delimiter or body line. */
const isNonCodeLine = (trimmed: string): boolean =>
    trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed === "*/" || BLOCK_COMMENT_BODY.test(trimmed);

/** 1-based index of the first line after `line` that holds code, or `undefined`. */
const nextCodeLine = (lines: ReadonlyArray<string>, line: number): number | undefined => {
    for (let index = line; index < lines.length; index += 1) {
        if (!isNonCodeLine((lines[index] ?? "").trim())) {
            return index + 1;
        }
    }

    return undefined;
};

/**
 * The span a `.ts` directive attaches to: the smallest node starting at the first token of the
 * next code line, climbed while its parent starts at the same position. The climb stops below the
 * `SourceFile` and any `SyntaxList`, so a directive above a file's first statement attaches to that
 * statement and not to the whole file.
 */
const tsSpanOf = (sourceFile: SourceFile, lines: ReadonlyArray<string>, directiveLine: number): ParsedDirective["span"] => {
    const first = nextCodeLine(lines, directiveLine);

    if (first === undefined) {
        return undefined;
    }

    let offset = 0;

    for (let index = 0; index < first - 1; index += 1) {
        offset += (lines[index] ?? "").length + 1;
    }

    const text = lines[first - 1] ?? "";
    const position = offset + (text.length - text.trimStart().length);
    const token = sourceFile.getDescendantAtPos(position);

    if (token === undefined) {
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

    return { first, last: node.getEndLineNumber() };
};

/** Every rule-form directive in one `.ts` source file, with the code it attaches to. */
const tsDirectivesOf = (sourceFile: SourceFile, display: string, key: string): ParsedDirective[] => {
    const lines = sourceFile.getFullText().split("\n");
    const directives: ParsedDirective[] = [];

    lines.forEach((text, index) => {
        const match = DIRECTIVE_LINE.exec(text.trimEnd());
        const rest = match?.[1];

        if (rest === undefined) {
            return;
        }

        const rule = suppressionRuleOf(rest);

        if (rule === undefined) {
            return;
        }

        const separator = rest.indexOf("--");
        const reason = separator === -1 ? "" : rest.slice(separator + 2).trim();

        directives.push({ display, key, line: index + 1, reason, rule, span: tsSpanOf(sourceFile, lines, index + 1) });
    });

    return directives;
};

/** Every rule-form directive in `wrangler.jsonc`: a JSONC line comment attaches to the next line holding a key. */
const wranglerDirectivesOf = (projectRoot: string): ParsedDirective[] => {
    const path = join(projectRoot, "wrangler.jsonc");

    if (!existsSync(path)) {
        return [];
    }

    const lines = readFileSync(path, "utf8").split("\n");
    const directives: ParsedDirective[] = [];

    lines.forEach((text, index) => {
        const match = DIRECTIVE_LINE.exec(text.trimEnd());
        const rest = match?.[1];

        if (rest === undefined) {
            return;
        }

        const rule = suppressionRuleOf(rest);

        if (rule === undefined) {
            return;
        }

        const separator = rest.indexOf("--");
        const reason = separator === -1 ? "" : rest.slice(separator + 2).trim();
        const first = nextCodeLine(lines, index + 1);

        directives.push({
            display: "wrangler.jsonc",
            key: "wrangler.jsonc",
            line: index + 1,
            reason,
            rule,
            span: first === undefined ? undefined : { first, last: first },
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
 * directives that cannot apply or apply to nothing. Runs on the post-policy list so the
 * severity floor cannot hide a directive that does apply, and never on a `lint: false` run.
 */
const applySuppressions = (project: Project, projectRoot: string, lunoraDirectory: string, advisories: ReadonlyArray<Finding>): Finding[] => {
    const parsed: ParsedDirective[] = [...wranglerDirectivesOf(projectRoot)];

    for (const sourceFile of project.getSourceFiles()) {
        const absolute = sourceFile.getFilePath();
        const inside = relative(lunoraDirectory, absolute);

        if (inside === "" || inside.startsWith("..")) {
            continue;
        }

        parsed.push(...tsDirectivesOf(sourceFile, relativeDisplay(projectRoot, absolute), normaliseFile(inside.split(sep).join("/"))));
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

        const { file, line } = finding.metadata;

        if (typeof file !== "string" || typeof line !== "number") {
            return finding;
        }

        const match = valid.find(
            (directive) =>
                directive.rule === finding.name &&
                directive.key === normaliseFile(file) &&
                directive.span !== undefined &&
                directive.span.first <= line &&
                line <= directive.span.last,
        );

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
