/**
 * The Lunora-managed block of the assets directory's `_headers` file.
 *
 * Cloudflare serves a static asset hit (a JS chunk, a prerendered page, the SPA
 * shell) without running the Worker, so `@lunora/runtime`'s `decorateResponse`
 * never sees it. `_headers` is the only place those responses get headers from,
 * and it applies ONLY to them: a Worker-produced response ignores it. So the two
 * layers never stack on one response.
 *
 * The block sits between two marker lines at the top of the file and is
 * rewritten on every build; everything outside it is the user's and is kept as
 * written. Top, because a `! Header` detach line only removes a header an
 * EARLIER rule added: a user rule after the block can detach a Lunora default
 * for its paths, one before it cannot.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { isEnvDisabled } from "../../../../shared/env-flag";
import {
    DEFAULT_CROSS_ORIGIN_OPENER_POLICY,
    DEFAULT_FRAME_OPTIONS,
    DEFAULT_HSTS,
    DEFAULT_PERMISSIONS_POLICY,
    DEFAULT_REFERRER_POLICY,
    htmlCspFor,
} from "../../../../shared/security-header-defaults";
import join from "../path";

const HEADERS_FILE = "_headers";

const BEGIN_MARKER = "# BEGIN lunora-managed: rewritten on every build. Put your own rules outside this block.";
const END_MARKER = "# END lunora-managed";

/** Cloudflare applies at most this many `_headers` rules; the rest of the file is ignored. */
const MAX_HEADERS_RULES = 100;

/**
 * The Worker's default security headers, as one `_headers` rule for every path.
 *
 * HSTS ships unconditionally, where the runtime gates it on HTTPS: browsers
 * ignore it on a plain-HTTP response (RFC 6797 §8.1), so a local `wrangler dev`
 * cannot get pinned by it. The CSP is the runtime's HTML policy, not its strict
 * `default-src 'none'` one: `_headers` cannot branch on content type, and the
 * strict policy would stop every static HTML page from loading its own scripts.
 * CORS is left to the Worker; static files are served same-origin.
 */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
    ["Strict-Transport-Security", DEFAULT_HSTS],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", DEFAULT_FRAME_OPTIONS],
    ["Referrer-Policy", DEFAULT_REFERRER_POLICY],
    ["Permissions-Policy", DEFAULT_PERMISSIONS_POLICY],
    ["Cross-Origin-Opener-Policy", DEFAULT_CROSS_ORIGIN_OPENER_POLICY],
    ["Content-Security-Policy", htmlCspFor(DEFAULT_FRAME_OPTIONS)],
];

interface AssetHeadersOptions {
    /** Write the default security headers for `/*`. `false` when the deployment opted out (`LUNORA_SECURITY_HEADERS=off`). */
    securityHeaders: boolean;
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

/** The user's lines: the `_headers` file with the managed block cut out and blank edges trimmed. */
const userLines = (text: string): string[] => {
    const lines = toLines(text);
    const begin = lines.indexOf(BEGIN_MARKER);

    if (begin === -1) {
        return dropBlankEdges(lines);
    }

    const end = lines.indexOf(END_MARKER, begin);

    return dropBlankEdges([...lines.slice(0, begin), ...(end === -1 ? [] : lines.slice(end + 1))]);
};

const isIndented = (line: string): boolean => line.startsWith(" ") || line.startsWith("\t");

const isRuleLine = (line: string): boolean => line !== "" && !isIndented(line) && !line.startsWith("#");

/**
 * Header names (lower-cased) the user's rules set. Cloudflare joins the values of
 * one header matched by two rules with a comma, so `X-Frame-Options: DENY` from
 * the user plus the block's `SAMEORIGIN` would ship `DENY, SAMEORIGIN`, which
 * browsers reject. The block defers to the user for every name they set, as the
 * runtime's `setIfAbsent` does. A `! Name` line detaches a header and sets
 * nothing, so it is not counted.
 */
const userHeaderNames = (lines: ReadonlyArray<string>): Set<string> => {
    const names = new Set<string>();

    for (const line of lines) {
        const entry = line.trim();
        const colon = entry.indexOf(":");

        if (isIndented(line) && colon > 0 && !entry.startsWith("!") && !entry.startsWith("#")) {
            names.add(entry.slice(0, colon).trim().toLowerCase());
        }
    }

    return names;
};

const renderBlock = (rules: ReadonlyArray<HeaderRule>): string[] => [
    BEGIN_MARKER,
    ...rules.flatMap((rule) => [rule.path, ...rule.headers.map(([name, value]) => `  ${name}: ${value}`)]),
    END_MARKER,
];

/**
 * Merge the managed block into `existing` (the current `_headers` text, or
 * `undefined` when there is none) and return the new text, or `undefined` when
 * the file should not exist. Pure.
 */
const mergeAssetHeaders = (
    existing: string | undefined,
    options: AssetHeadersOptions,
): { deferred: string[]; text: string | undefined; warnings: string[] } => {
    const user = userLines(existing ?? "");
    const taken = userHeaderNames(user);
    const deferred: string[] = [];
    const warnings: string[] = [];
    const rules: HeaderRule[] = [];

    if (options.securityHeaders) {
        const headers = SECURITY_HEADERS.filter(([name]) => {
            if (taken.has(name.toLowerCase())) {
                deferred.push(name);

                return false;
            }

            return true;
        });

        if (headers.length > 0) {
            rules.push({ headers, path: "/*" });
        }
    }

    if (user.filter((line) => isRuleLine(line)).length + rules.length > MAX_HEADERS_RULES) {
        warnings.push(
            `_headers has more than ${String(MAX_HEADERS_RULES)} rules with Lunora's added; Cloudflare ignores every rule past the ${String(MAX_HEADERS_RULES)}th`,
        );
    }

    const block = rules.length === 0 ? [] : renderBlock(rules);
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

const variablesOf = (scope: unknown): Record<string, unknown> | undefined => {
    if (typeof scope !== "object" || scope === null) {
        return undefined;
    }

    const { vars } = scope as { vars?: unknown };

    return typeof vars === "object" && vars !== null ? (vars as Record<string, unknown>) : undefined;
};

/**
 * Whether the deployment turned the security headers off through
 * `LUNORA_SECURITY_HEADERS` in wrangler's `vars`. `vars` is not inheritable, so
 * an `env.<name>` build reads that block's own. A `security.headers` passed to
 * `createWorker` in code cannot be seen at build time; see the docs' security page.
 */
const securityHeadersDisabled = (wrangler: unknown, environment?: string): boolean => {
    const scope = environment === undefined ? wrangler : (wrangler as { env?: Record<string, unknown> } | undefined)?.env?.[environment];

    return isEnvDisabled(variablesOf(scope)?.["LUNORA_SECURITY_HEADERS"]);
};

export type { AssetHeadersOptions, AssetHeadersResult };
export { mergeAssetHeaders, securityHeadersDisabled, writeAssetHeaders };
