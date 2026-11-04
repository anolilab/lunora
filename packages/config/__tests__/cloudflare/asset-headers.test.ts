import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeAssetHeaders, writeAssetHeaders } from "../../src/cloudflare/asset-headers";

const BEGIN = "# BEGIN lunora-managed";
const END = "# END lunora-managed";

describe(mergeAssetHeaders, () => {
    it("writes the Worker's default security headers for every path when there is no _headers yet", () => {
        expect.assertions(1);

        expect(mergeAssetHeaders(undefined, { headers: true }).text).toBe(
            [
                "# BEGIN lunora-managed: rewritten on every build. Put your own rules outside this block.",
                "/*",
                "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
                "  X-Content-Type-Options: nosniff",
                "  X-Frame-Options: SAMEORIGIN",
                "  Referrer-Policy: strict-origin-when-cross-origin",
                "  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
                "  Cross-Origin-Opener-Policy: same-origin-allow-popups",
                "  Content-Security-Policy: base-uri 'none'; object-src 'none'; frame-ancestors 'self'",
                "# END lunora-managed",
                "",
            ].join("\n"),
        );
    });

    it("keeps the user's rules as written and puts the block before them, where their detach lines can act on it", () => {
        expect.assertions(2);

        const user = "/blog/*\n  X-Robots-Tag: noindex\n";
        const { text } = mergeAssetHeaders(user, { headers: true });

        expect(text?.startsWith(BEGIN)).toBe(true);
        expect(text?.endsWith(`${END}\n\n${user}`)).toBe(true);
    });

    it("replaces its own block in place instead of appending a second one", () => {
        expect.assertions(2);

        const first = mergeAssetHeaders("/a\n  X-A: 1\n", { headers: true }).text;
        const second = mergeAssetHeaders(first, { headers: true }).text;

        expect(second).toBe(first);
        expect(second?.split(BEGIN)).toHaveLength(2);
    });

    it("leaves a header to a user rule for /* that sets it, since Cloudflare would send both values", () => {
        expect.assertions(4);

        const merged = mergeAssetHeaders("/*\n  x-frame-options: DENY\n  ! Permissions-Policy\n", { headers: true });

        expect(merged.deferred).toEqual(["X-Frame-Options"]);
        expect(merged.text).not.toContain("X-Frame-Options: SAMEORIGIN");
        // A detach line sets nothing, so the block still sends the default.
        expect(merged.text).toContain("  Permissions-Policy: accelerometer=()");
        expect(merged.warnings).toEqual([]);
    });

    it("keeps the default for a narrower rule, which replaces it by detaching first, and warns when it does not", () => {
        expect.assertions(3);

        const replaced = mergeAssetHeaders("/cb/*\n  ! Cross-Origin-Opener-Policy\n  Cross-Origin-Opener-Policy: unsafe-none\n", { headers: true });
        const stacked = mergeAssetHeaders("/cb/*\n  Cross-Origin-Opener-Policy: unsafe-none\n", { headers: true });

        expect(replaced.text).toContain("  Cross-Origin-Opener-Policy: same-origin-allow-popups");
        expect(replaced.warnings).toEqual([]);
        expect(stacked.warnings.join(" ")).toContain('add "! Cross-Origin-Opener-Policy" above it');
    });

    it("keeps the default for every other host when a host-qualified rule sets a managed header", () => {
        expect.assertions(3);

        const merged = mergeAssetHeaders("https://one.example/*\n  X-Frame-Options: DENY\n", { headers: true });

        // `https://one.example/*` covers one host; the block's `/*` still serves every other.
        expect(merged.deferred).toEqual([]);
        expect(merged.text).toContain("  X-Frame-Options: SAMEORIGIN");
        expect(merged.warnings.join(" ")).toContain('"https://one.example/*" sets X-Frame-Options on top of Lunora\'s default');
    });

    it("leaves a file whose managed block lost its END marker as it is, and says so", () => {
        expect.assertions(2);

        const broken = `${BEGIN}: rewritten on every build. Put your own rules outside this block.\n/*\n  X-Frame-Options: SAMEORIGIN\n/mine\n  X-Mine: 1\n`;
        const merged = mergeAssetHeaders(broken, { headers: true });

        expect(merged.text).toBe(broken);
        expect(merged.warnings.join(" ")).toContain(`no "${END}" line`);
    });

    it("writes the values security.headers resolves to, through the runtime's resolver", () => {
        expect.assertions(4);

        const { text } = mergeAssetHeaders(undefined, {
            headers: { crossOriginOpenerPolicy: "same-origin", frameAncestors: ["https://partner.example"], hsts: false, referrerPolicy: false },
        });

        expect(text).toContain("  Cross-Origin-Opener-Policy: same-origin\n");
        expect(text).toContain("  Content-Security-Policy: base-uri 'none'; object-src 'none'; frame-ancestors 'self' https://partner.example");
        expect(text).not.toContain("X-Frame-Options");
        expect(text).not.toMatch(/Strict-Transport-Security|Referrer-Policy/u);
    });

    it("drops the block, and the file it alone made up, when the security headers are off", () => {
        expect.assertions(2);

        const generated = mergeAssetHeaders(undefined, { headers: true }).text;

        expect(mergeAssetHeaders(generated, { headers: false }).text).toBeUndefined();
        expect(mergeAssetHeaders(`${generated ?? ""}\n/a\n  X-A: 1\n`, { headers: false }).text).toBe("/a\n  X-A: 1\n");
    });

    it("gives the hashed assets directory a year-long immutable Cache-Control", () => {
        expect.assertions(2);

        expect(mergeAssetHeaders(undefined, { immutableDirectory: "assets", headers: false }).text).toBe(
            [
                "# BEGIN lunora-managed: rewritten on every build. Put your own rules outside this block.",
                "/assets/*",
                "  Cache-Control: public, max-age=31536000, immutable",
                "# END lunora-managed",
                "",
            ].join("\n"),
        );
        expect(mergeAssetHeaders(undefined, { immutableDirectory: "./static/js/", headers: true }).text).toContain("/static/js/*\n  Cache-Control:");
    });

    it.each([["/*"], ["/assets/*"], ["/assets/app.js"], ["/:dir/*"], ["https://example.com/assets/*"]])(
        "leaves the immutable rule out when a user rule for %s sets Cache-Control, which Cloudflare would comma-join",
        (rule) => {
            expect.assertions(2);

            const merged = mergeAssetHeaders(`${rule}\n  Cache-Control: no-store\n`, { immutableDirectory: "assets", headers: true });

            expect(merged.deferred).toEqual(["Cache-Control"]);
            expect(merged.text).not.toContain("immutable");
        },
    );

    it.each([["/img/*"], ["/assets"], ["/static/assets/*"]])("keeps the immutable rule beside a user Cache-Control for %s, which never reaches it", (rule) => {
        expect.assertions(1);

        expect(mergeAssetHeaders(`${rule}\n  Cache-Control: max-age=60\n`, { immutableDirectory: "assets", headers: true }).text).toContain(
            "/assets/*\n  Cache-Control: public, max-age=31536000, immutable",
        );
    });

    it("warns when the block pushes the file past Cloudflare's 100-rule cap", () => {
        expect.assertions(1);

        const user = Array.from({ length: 100 }, (_, index) => `/r${String(index)}\n  X-R: ${String(index)}`).join("\n");

        expect(mergeAssetHeaders(user, { headers: true }).warnings.join(" ")).toContain("more than 100 rules");
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

        const result = writeAssetHeaders(directory, { headers: true });
        const text = readFileSync(join(directory, "_headers"), "utf8");

        expect(result.path).toBe(join(directory, "_headers"));
        expect(text).toMatch(/# END lunora-managed\n\n\/img\/\*\n {2}Cache-Control: max-age=60\n$/u);
    });

    it("removes a _headers that held only the block once there is nothing to write", () => {
        expect.assertions(2);

        writeAssetHeaders(directory, { headers: true });

        expect(existsSync(join(directory, "_headers"))).toBe(true);

        writeAssetHeaders(directory, { headers: false });

        expect(existsSync(join(directory, "_headers"))).toBe(false);
    });
});
