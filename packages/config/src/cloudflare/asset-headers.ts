/**
 * The Lunora-managed block of the assets directory's `_headers` file.
 *
 * Cloudflare serves a static asset hit (a JS chunk, a prerendered page, the SPA
 * shell) without running the Worker, so `@lunora/runtime`'s `decorateResponse`
 * never sees it. `_headers` is the only place those responses get headers from,
 * and it applies ONLY to them: a Worker-produced response ignores it. So the two
 * layers never stack on one response. The exception is a single-page app whose
 * Worker runs first and serves files through the assets binding (`spaAssets` in
 * `@lunora/runtime`): Cloudflare applies `_headers` there too, and the Worker then
 * adds only the security headers the response lacks. A value set here wins, but a
 * `! Header` that only detaches a default is undone on those responses.
 *
 * The block sits between two marker lines at the top of the file and is
 * rewritten on every build; everything outside it is the user's and is kept as
 * written. Top, because a `! Header` detach line only removes a header an
 * EARLIER rule added: a user rule after the block can detach a Lunora default
 * for its paths, one before it cannot.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { LunoraError } from "@lunora/errors";

import type { SecurityHeadersOptions } from "../../../../shared/security-headers";
import { parseSecurityHeaders, resolveSecurityHeaders } from "../../../../shared/security-headers";
import join from "../path";

const HEADERS_FILE = "_headers";

const BEGIN_MARKER = "# BEGIN lunora-managed: rewritten on every build. Put your own rules outside this block.";
const END_MARKER = "# END lunora-managed";

/** Cloudflare applies at most this many `_headers` rules; the rest of the file is ignored. */
const MAX_HEADERS_RULES = 100;

/** Cloudflare's cap on one `_headers` line, indentation and header name included. */
const MAX_HEADERS_LINE_LENGTH = 2000;

/**
 * The Worker's security headers for `headers`, as `_headers` lines for every
 * path. Resolved by the same function the runtime uses, so a value set once in
 * `lunora.config` reaches both.
 *
 * HSTS ships unconditionally, where the runtime gates it on HTTPS: browsers
 * ignore it on a plain-HTTP response (RFC 6797 §8.1), so a local `wrangler dev`
 * cannot get pinned by it. The CSP is the runtime's HTML policy, not its strict
 * `default-src 'none'` one: `_headers` cannot branch on content type, and the
 * strict policy would stop every static HTML page from loading its own scripts.
 * CORS is left to the Worker; static files are served same-origin.
 */
const securityHeaderLines = (headers: boolean | SecurityHeadersOptions | undefined): (readonly [string, string])[] => {
    // Parsed as `createWorker` parses it: a value with a line break would otherwise split into extra `_headers` lines.
    const parsed = parseSecurityHeaders(headers);

    if (!parsed.ok) {
        throw new LunoraError("CONFIG_INVALID", `[lunora] cannot write _headers: ${parsed.problems.join("; ")}`);
    }

    const resolved = resolveSecurityHeaders(parsed.value);

    if (!resolved.enabled) {
        return [];
    }

    const lines: (readonly [string, string | undefined])[] = [
        ["Strict-Transport-Security", resolved.hsts],
        ["X-Content-Type-Options", "nosniff"],
        ["X-Frame-Options", resolved.frameOptions],
        ["Referrer-Policy", resolved.referrerPolicy],
        ["Permissions-Policy", resolved.permissionsPolicy],
        ["Cross-Origin-Opener-Policy", resolved.coop],
        ["Content-Security-Policy", resolved.csp?.htmlValue],
    ];

    return lines.filter((line): line is readonly [string, string] => line[1] !== undefined);
};

/**
 * For fingerprinted build output: a file whose name changes with its content can
 * be cached for good. Cloudflare's default for an asset is `public, max-age=0,
 * must-revalidate`, which costs a revalidation round-trip per chunk on every
 * navigation; a `_headers` value replaces it.
 */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

interface AssetHeadersOptions {
    /**
     * The security headers to write for `/*`, in the runtime's `security.headers`
     * shape: `undefined` or `true` for the defaults, `false` for none.
     */
    headers: boolean | SecurityHeadersOptions | undefined;

    /**
     * The directory, relative to the assets root, that holds only content-hashed
     * files (Vite's `build.assetsDir`). Its files get {@link IMMUTABLE_CACHE_CONTROL}.
     * Omit it when that cannot be promised: one unhashed file there would be
     * cached for a year. Omit it too when `not_found_handling` is a fallback
     * (`single-page-application`, `404-page`): `_headers` matches the request
     * path, so a request for a chunk a later deploy removed would get the
     * fallback page with this policy, and keep it for a year.
     */
    immutableDirectory?: string;
}

interface AssetHeadersResult {
    /** Header names left out of the block because a rule outside it already sets them. */
    deferred: string[];
    /** Absolute path of the `_headers` file, or `undefined` when there is none. */
    path: string | undefined;
    /** Non-fatal notes for the build log. */
    warnings: string[];
}

type HeaderRule = { headers: ReadonlyArray<readonly [string, string]>; path: string };

const toLines = (text: string): string[] => text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

const dropBlankEdges = (lines: string[]): string[] => {
    let start = 0;
    let end = lines.length;

    while (start < end && lines[start]?.trim() === "") {
        start += 1;
    }

    while (end > start && lines[end - 1]?.trim() === "") {
        end -= 1;
    }

    return lines.slice(start, end);
};

/**
 * The user's lines: the `_headers` file with the managed block cut out and blank
 * edges trimmed. `undefined` when the block has lost its END marker: where the
 * managed rules stop and the user's begin can no longer be told, so neither may
 * be rewritten.
 */
const userLines = (text: string): string[] | undefined => {
    const lines = toLines(text);
    const begin = lines.indexOf(BEGIN_MARKER);

    if (begin === -1) {
        return dropBlankEdges(lines);
    }

    const end = lines.indexOf(END_MARKER, begin);

    return end === -1 ? undefined : dropBlankEdges([...lines.slice(0, begin), ...lines.slice(end + 1)]);
};

const isIndented = (line: string): boolean => line.startsWith(" ") || line.startsWith("\t");

const isRuleLine = (line: string): boolean => line !== "" && !isIndented(line) && !line.startsWith("#");

/** The path part of a `_headers` rule, which may be an absolute `https://host/path` URL. */
const rulePath = (rule: string): string => {
    if (!rule.startsWith("https://")) {
        return rule;
    }

    const slash = rule.indexOf("/", "https://".length);

    return slash === -1 ? "/" : rule.slice(slash);
};

/** A user rule: its path line, and each header it sets with whether the rule detached that header first (`! Name`). Names are lower-cased. */
interface UserRule {
    rule: string;
    sets: { detached: boolean; name: string }[];
}

/** The user's lines parsed once into their rules; comments, blank lines and a header line before any rule are skipped. */
const parseUserRules = (lines: ReadonlyArray<string>): UserRule[] => {
    const rules: UserRule[] = [];
    let detached = new Set<string>();

    for (const line of lines) {
        if (isRuleLine(line)) {
            rules.push({ rule: line.trim(), sets: [] });
            detached = new Set();

            continue;
        }

        const current = rules.at(-1);
        const entry = line.trim();

        if (current === undefined || !isIndented(line) || entry.startsWith("#")) {
            continue;
        }

        if (entry.startsWith("!")) {
            detached.add(entry.slice(1).trim().toLowerCase());

            continue;
        }

        const colon = entry.indexOf(":");

        if (colon > 0) {
            const name = entry.slice(0, colon).trim().toLowerCase();

            current.sets.push({ detached: detached.has(name), name });
        }
    }

    return rules;
};

/**
 * How the user's rules interact with the block's security headers.
 *
 * Cloudflare joins the values of one header that two matching rules set (two
 * header lines on the wire), so `X-Frame-Options: DENY` from the user plus the
 * block's `SAMEORIGIN` ships both, which browsers reject. A user rule for `/*`
 * means "this value everywhere", so the block leaves that header to it (`taken`),
 * as the runtime's `setIfAbsent` leaves a handler's own. Any narrower rule, a
 * host-qualified `https://host/*` included (it covers one host, and the block
 * still serves every other), must detach the default first (`! Name`, then
 * `Name: value`); one that sets a managed header without detaching it is
 * reported (`stacked`).
 */
const userHeaderUse = (rules: ReadonlyArray<UserRule>): { stacked: { name: string; rule: string }[]; taken: Set<string> } => {
    const taken = new Set<string>();
    const stacked: { name: string; rule: string }[] = [];

    for (const { rule, sets } of rules) {
        for (const { detached, name } of sets) {
            if (rule === "/*") {
                taken.add(name);
            } else if (!detached) {
                stacked.push({ name, rule });
            }
        }
    }

    return { stacked, taken };
};

/**
 * Whether `rule` could match a request for some file under `/<directory>/`: each
 * directory segment must be equal, a `:placeholder` (one segment) or a splat
 * (the rest), and anything past the directory names some file in it.
 */
const ruleReaches = (rule: string, directory: string): boolean => {
    const ruleSegments = rulePath(rule).split("/").slice(1);
    const directorySegments = directory.split("/");

    for (const [index, segment] of ruleSegments.entries()) {
        const expected = directorySegments[index];

        if (segment.includes("*") || expected === undefined) {
            return true;
        }

        if (!segment.startsWith(":") && segment !== expected) {
            return false;
        }
    }

    return false;
};

/**
 * Whether a user rule that sets `Cache-Control` could match a file under
 * `/<directory>/`. Only then would Cloudflare comma-join it with the immutable
 * rule; a user policy for `/img/*` leaves the hashed directory alone.
 */
const userCachesUnder = (rules: ReadonlyArray<UserRule>, directory: string): boolean =>
    rules.some(({ rule, sets }) => sets.some(({ name }) => name === "cache-control") && ruleReaches(rule, directory));

const renderBlock = (rules: ReadonlyArray<HeaderRule>): string[] => [
    BEGIN_MARKER,
    ...rules.flatMap((rule) => [rule.path, ...rule.headers.map(([name, value]) => `  ${name}: ${value}`)]),
    END_MARKER,
];

const FRAME_ANCESTORS = /^frame-ancestors(?:\s|$)/iu;

/** `policy` without its `frame-ancestors` directive. */
const withoutFrameAncestors = (policy: string): string =>
    policy
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => directive !== "" && !FRAME_ANCESTORS.test(directive))
        .join("; ");

/**
 * The CSP to write when a user rule for `/*` owns `X-Frame-Options` but not the
 * CSP. Browsers that read `frame-ancestors` ignore `X-Frame-Options`, so the
 * derived `frame-ancestors 'self'` would override a stricter user `DENY` (or
 * re-allow framing the user turned off): Lunora's own policy drops the directive
 * and leaves framing to the user's header. A `csp` the user wrote in
 * `lunora.config` is theirs and is kept, with a warning when it says
 * `frame-ancestors`.
 */
const cspBesideUserFraming = (value: string, cspIsDerived: boolean, warnings: string[]): string => {
    if (cspIsDerived) {
        return withoutFrameAncestors(value);
    }

    if (value.split(";").some((directive) => FRAME_ANCESTORS.test(directive.trim()))) {
        warnings.push(
            "your _headers rule for /* sets X-Frame-Options, but the csp in lunora.config carries a frame-ancestors directive, which browsers apply instead of X-Frame-Options; make the two agree",
        );
    }

    return value;
};

/**
 * Refuse a header line Cloudflare would not apply. `_headers` drops a line past
 * its length cap, and a CSP from `frameAncestors` has already dropped
 * `X-Frame-Options`, so the static pages would ship with no framing protection
 * at all. The Worker has no such cap, so this is a build error, not a parse one.
 * @throws LunoraError `INTERNAL` naming the header, its length, and how to shorten it.
 */
const assertLineFits = (name: string, value: string): void => {
    const line = `  ${name}: ${value}`;

    if (line.length > MAX_HEADERS_LINE_LENGTH) {
        throw new LunoraError(
            "INTERNAL",
            `[lunora] the _headers line for ${name} would be ${String(line.length)} characters; Cloudflare ignores a line longer than ${String(MAX_HEADERS_LINE_LENGTH)}, which would leave every static page without it. ` +
                "Shorten security.headers in lunora.config: list fewer frameAncestors origins (one *.example.com entry covers its subdomains), or a shorter csp.",
        );
    }
};

/**
 * The block's `/*` rule: the security headers minus those a user rule for `/*`
 * sets, with a warning for each narrower user rule that stacks a value on a
 * default instead of detaching it.
 * @throws LunoraError `INTERNAL` for a line past Cloudflare's length cap — see {@link assertLineFits}.
 */
const planSecurityRule = (
    security: ReadonlyArray<readonly [string, string]>,
    use: ReturnType<typeof userHeaderUse>,
    cspIsDerived: boolean,
): { deferred: string[]; rule: HeaderRule | undefined; warnings: string[] } => {
    const deferred: string[] = [];
    const warnings: string[] = [];
    const headers: (readonly [string, string])[] = [];

    for (const [name, written] of security) {
        for (const stacked of use.stacked.filter((entry) => entry.name === name.toLowerCase())) {
            warnings.push(
                `_headers rule "${stacked.rule}" sets ${name} on top of Lunora's default, so both values are sent; add "! ${name}" above it in that rule to replace the default`,
            );
        }

        if (use.taken.has(name.toLowerCase())) {
            deferred.push(name);

            continue;
        }

        const value = name === "Content-Security-Policy" && use.taken.has("x-frame-options") ? cspBesideUserFraming(written, cspIsDerived, warnings) : written;

        assertLineFits(name, value);
        headers.push([name, value]);
    }

    return { deferred, rule: headers.length === 0 ? undefined : { headers, path: "/*" }, warnings };
};

/**
 * The managed rules that fit beside the user's under Cloudflare's rule cap, in
 * priority order (security before caching). Cloudflare ignores every rule past
 * the cap, and the block sits first, so a managed rule over it would push one of
 * the user's out. The user's rules win: a managed rule that does not fit is left
 * out and named in a warning.
 */
const fitRules = (managed: ReadonlyArray<HeaderRule>, userRuleCount: number, warnings: string[]): HeaderRule[] => {
    const room = Math.max(0, MAX_HEADERS_RULES - userRuleCount);
    const kept = managed.slice(0, room);
    const dropped = managed.slice(room);

    if (dropped.length > 0) {
        warnings.push(
            `_headers already has ${String(userRuleCount)} of your rules, and Cloudflare applies at most ${String(MAX_HEADERS_RULES)}; Lunora left out its ${dropped
                .map((rule) => rule.path)
                .join(", ")} rule so yours still apply. Merge some of your rules to make room`,
        );
    }

    if (userRuleCount > MAX_HEADERS_RULES) {
        warnings.push(`_headers has ${String(userRuleCount)} rules of your own; Cloudflare ignores every rule past the ${String(MAX_HEADERS_RULES)}th`);
    }

    return kept;
};

/**
 * Merge the managed block into `existing` (the current `_headers` text, or
 * `undefined` when there is none) and return the new text, or `undefined` when
 * the file should not exist. Pure.
 * @throws LunoraError `INTERNAL` for a header line Cloudflare would ignore — see {@link assertLineFits}.
 * @throws LunoraError `CONFIG_INVALID` for `headers` that `parseSecurityHeaders` refuses, as `createWorker` would.
 */
const mergeAssetHeaders = (
    existing: string | undefined,
    options: AssetHeadersOptions,
): { deferred: string[]; text: string | undefined; warnings: string[] } => {
    const user = userLines(existing ?? "");

    if (user === undefined) {
        return {
            deferred: [],
            text: existing,
            warnings: [
                `_headers has "${BEGIN_MARKER}" but no "${END_MARKER}" line, so Lunora cannot tell its rules from yours and left the file as it is; put the END line back after the managed rules, or delete the managed block`,
            ],
        };
    }

    const userRules = parseUserRules(user);
    const deferred: string[] = [];
    const warnings: string[] = [];
    const rules: HeaderRule[] = [];
    const cspIsDerived = typeof options.headers !== "object" || typeof options.headers.csp !== "string";
    const security = planSecurityRule(securityHeaderLines(options.headers), userHeaderUse(userRules), cspIsDerived);

    deferred.push(...security.deferred);
    warnings.push(...security.warnings);

    if (security.rule !== undefined) {
        rules.push(security.rule);
    }

    const immutable = options.immutableDirectory
        ?.replaceAll("\\", "/")
        .split("/")
        .filter((segment) => segment !== "" && segment !== ".")
        .join("/");

    if (immutable !== undefined && immutable !== "") {
        if (userCachesUnder(userRules, immutable)) {
            deferred.push("Cache-Control");
        } else {
            rules.push({ headers: [["Cache-Control", IMMUTABLE_CACHE_CONTROL]], path: `/${immutable}/*` });
        }
    }

    const fitting = fitRules(rules, userRules.length, warnings);
    const block = fitting.length === 0 ? [] : renderBlock(fitting);
    const lines = user.length > 0 && block.length > 0 ? [...block, "", ...user] : [...block, ...user];

    return { deferred, text: lines.length === 0 ? undefined : `${lines.join("\n")}\n`, warnings };
};

/** Rewrite `<directory>/_headers` with the managed block; a file left holding nothing is removed. */
const writeAssetHeaders = (directory: string, options: AssetHeadersOptions): AssetHeadersResult => {
    const path = join(directory, HEADERS_FILE);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const merged = mergeAssetHeaders(existing, options);

    if (merged.text === undefined) {
        if (existing !== undefined) {
            rmSync(path, { force: true });
        }

        return { deferred: merged.deferred, path: undefined, warnings: merged.warnings };
    }

    if (merged.text !== existing) {
        writeFileSync(path, merged.text, "utf8");
    }

    return { deferred: merged.deferred, path, warnings: merged.warnings };
};

export type { AssetHeadersOptions, AssetHeadersResult };
export { mergeAssetHeaders, writeAssetHeaders };
