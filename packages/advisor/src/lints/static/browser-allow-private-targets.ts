import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createBrowser({ allowPrivateTargets: true })`.
 *
 * `@lunora/browser` blocks navigation to private / internal / loopback addresses
 * by default — that guard is what stops a browser action from being turned into a
 * server-side request forgery (SSRF) tool that reaches cloud metadata endpoints
 * (`169.254.169.254`), internal services, or `localhost`. Setting
 * `allowPrivateTargets: true` disables it wholesale. Combined with a
 * request-supplied URL that is the classic SSRF-to-metadata exfiltration path.
 *
 * Runs only when the codegen feeder supplies config-call evidence
 * (`context.configCalls`); a runtime caller flags nothing. One finding per
 * opted-out browser.
 */
const browserAllowPrivateTargets: Lint = {
    categories: ["SECURITY"],
    description:
        "`createBrowser({ allowPrivateTargets: true })` disables the private/internal-IP SSRF guard, letting a navigated URL reach cloud metadata endpoints, internal services, or loopback. Combined with a request-supplied URL this is a server-side request forgery path.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "browser_allow_private_targets",
    remediation:
        "Remove `allowPrivateTargets: true` from `createBrowser({...})` so the private/internal-address guard stays on. If a specific internal host is genuinely required, pin it with an `allowedHosts` allowlist instead of opening all private targets.",
    run: (context) => {
        if (context.configCalls === undefined) {
            return [];
        }

        return context.configCalls
            .filter((call) => call.callee === "createBrowser" && call.trueKeys.includes("allowPrivateTargets"))
            .map((call) =>
                emit(browserAllowPrivateTargets, {
                    cacheKey: `browser_allow_private_targets:${call.file}:${call.line.toString()}`,
                    detail: `\`createBrowser({ allowPrivateTargets: true })\` in ${call.file}:${call.line.toString()} disables the private/internal-address SSRF guard — a navigated URL can then reach cloud metadata, internal services, or loopback. Remove the override, or pin the specific host with \`allowedHosts\` instead.`,
                    metadata: { callee: call.callee, file: call.file, line: call.line },
                }),
            );
    },
    source: "static",
    title: "Browser with private-target SSRF guard disabled",
};

export default browserAllowPrivateTargets;
