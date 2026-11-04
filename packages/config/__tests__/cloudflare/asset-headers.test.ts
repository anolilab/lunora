import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeAssetHeaders, securityHeadersDisabled, writeAssetHeaders } from "../../src/cloudflare/asset-headers";

const BEGIN = "# BEGIN lunora-managed";
const END = "# END lunora-managed";

describe(mergeAssetHeaders, () => {
    it("writes the Worker's default security headers for every path when there is no _headers yet", () => {
        expect.assertions(1);

        expect(mergeAssetHeaders(undefined, { securityHeaders: true }).text).toBe(
            [
                "# BEGIN lunora-managed: rewritten on every build. Put your own rules outside this block.",
                "/*",
                "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
                "  X-Content-Type-Options: nosniff",
                "  X-Frame-Options: SAMEORIGIN",
                "  Referrer-Policy: strict-origin-when-cross-origin",
                "  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
                "  Cross-Origin-Opener-Policy: same-origin",
                "  Content-Security-Policy: base-uri 'none'; object-src 'none'; frame-ancestors 'self'",
                "# END lunora-managed",
                "",
            ].join("\n"),
        );
    });

    it("keeps the user's rules as written and puts the block before them, where their detach lines can act on it", () => {
        expect.assertions(2);

        const user = "/blog/*\n  X-Robots-Tag: noindex\n";
        const { text } = mergeAssetHeaders(user, { securityHeaders: true });

        expect(text?.startsWith(BEGIN)).toBe(true);
        expect(text?.endsWith(`${END}\n\n${user}`)).toBe(true);
    });

    it("replaces its own block in place instead of appending a second one", () => {
        expect.assertions(2);

        const first = mergeAssetHeaders("/a\n  X-A: 1\n", { securityHeaders: true }).text;
        const second = mergeAssetHeaders(first, { securityHeaders: true }).text;

        expect(second).toBe(first);
        expect(second?.split(BEGIN)).toHaveLength(2);
    });

    it("leaves out any header the user's rules set, since Cloudflare would comma-join the two values", () => {
        expect.assertions(4);

        const merged = mergeAssetHeaders("/*\n  x-frame-options: DENY\n  ! Permissions-Policy\n/docs/*\n  Content-Security-Policy: default-src 'self'\n", {
            securityHeaders: true,
        });

        expect(merged.deferred).toEqual(["X-Frame-Options", "Content-Security-Policy"]);
        expect(merged.text).not.toContain("X-Frame-Options: SAMEORIGIN");
        expect(merged.text).not.toContain("frame-ancestors 'self'");
        // A detach line sets nothing, so the block still sends the default.
        expect(merged.text).toContain("  Permissions-Policy: accelerometer=()");
    });

    it("drops the block, and the file it alone made up, when the security headers are off", () => {
        expect.assertions(2);

        const generated = mergeAssetHeaders(undefined, { securityHeaders: true }).text;

        expect(mergeAssetHeaders(generated, { securityHeaders: false }).text).toBeUndefined();
        expect(mergeAssetHeaders(`${generated ?? ""}\n/a\n  X-A: 1\n`, { securityHeaders: false }).text).toBe("/a\n  X-A: 1\n");
    });

    it("gives the hashed assets directory a year-long immutable Cache-Control", () => {
        expect.assertions(2);

        expect(mergeAssetHeaders(undefined, { immutableDirectory: "assets", securityHeaders: false }).text).toBe(
            [
                "# BEGIN lunora-managed: rewritten on every build. Put your own rules outside this block.",
                "/assets/*",
                "  Cache-Control: public, max-age=31536000, immutable",
                "# END lunora-managed",
                "",
            ].join("\n"),
        );
        expect(mergeAssetHeaders(undefined, { immutableDirectory: "./static/js/", securityHeaders: true }).text).toContain("/static/js/*\n  Cache-Control:");
    });

    it.each([["/*"], ["/assets/*"], ["/assets/app.js"], ["/:dir/*"], ["https://example.com/assets/*"]])(
        "leaves the immutable rule out when a user rule for %s sets Cache-Control, which Cloudflare would comma-join",
        (rule) => {
            expect.assertions(2);

            const merged = mergeAssetHeaders(`${rule}\n  Cache-Control: no-store\n`, { immutableDirectory: "assets", securityHeaders: true });

            expect(merged.deferred).toEqual(["Cache-Control"]);
            expect(merged.text).not.toContain("immutable");
        },
    );

    it.each([["/img/*"], ["/assets"], ["/static/assets/*"]])("keeps the immutable rule beside a user Cache-Control for %s, which never reaches it", (rule) => {
        expect.assertions(1);

        expect(mergeAssetHeaders(`${rule}\n  Cache-Control: max-age=60\n`, { immutableDirectory: "assets", securityHeaders: true }).text).toContain(
            "/assets/*\n  Cache-Control: public, max-age=31536000, immutable",
        );
    });

    it("warns when the block pushes the file past Cloudflare's 100-rule cap", () => {
        expect.assertions(1);

        const user = Array.from({ length: 100 }, (_, index) => `/r${String(index)}\n  X-R: ${String(index)}`).join("\n");

        expect(mergeAssetHeaders(user, { securityHeaders: true }).warnings.join(" ")).toContain("more than 100 rules");
    });
});

describe(writeAssetHeaders, () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "lunora-asset-headers-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("merges into a _headers the build copied from publicDir", () => {
        expect.assertions(2);

        writeFileSync(join(directory, "_headers"), "/img/*\n  Cache-Control: max-age=60\n", "utf8");

        const result = writeAssetHeaders(directory, { securityHeaders: true });
        const text = readFileSync(join(directory, "_headers"), "utf8");

        expect(result.path).toBe(join(directory, "_headers"));
        expect(text).toMatch(/# END lunora-managed\n\n\/img\/\*\n {2}Cache-Control: max-age=60\n$/u);
    });

    it("removes a _headers that held only the block once there is nothing to write", () => {
        expect.assertions(2);

        writeAssetHeaders(directory, { securityHeaders: true });

        expect(existsSync(join(directory, "_headers"))).toBe(true);

        writeAssetHeaders(directory, { securityHeaders: false });

        expect(existsSync(join(directory, "_headers"))).toBe(false);
    });
});

describe(securityHeadersDisabled, () => {
    it("reads LUNORA_SECURITY_HEADERS from the top-level vars, or the env block's own", () => {
        expect.assertions(5);

        const wrangler = { env: { open: { vars: {} }, staging: { vars: { LUNORA_SECURITY_HEADERS: "false" } } }, vars: { LUNORA_SECURITY_HEADERS: "off" } };

        expect(securityHeadersDisabled(wrangler)).toBe(true);
        expect(securityHeadersDisabled(wrangler, "staging")).toBe(true);
        // `vars` is not inheritable: an env block without the key does not inherit the top-level off.
        expect(securityHeadersDisabled(wrangler, "open")).toBe(false);
        expect(securityHeadersDisabled({ vars: { LUNORA_SECURITY_HEADERS: "on" } })).toBe(false);
        expect(securityHeadersDisabled(undefined)).toBe(false);
    });
});
