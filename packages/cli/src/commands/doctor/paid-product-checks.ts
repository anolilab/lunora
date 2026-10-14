/**
 * `lunora doctor`'s paid-product check. A metered Cloudflare product declared in
 * wrangler config is billed per use. None of the usage-alert products Cloudflare
 * documents (the Terraform provider's list) is one of these, so an account budget
 * alert is the only cap that can be set. Lunora cannot read budget alerts (the API
 * has no endpoint for them), so the check says what it can see and no more. It
 * makes no network call: the enablement signal is the binding itself. An account
 * may offer usage-alert products beyond the documented list, which this check does
 * not read.
 */
import { DEFAULT_TARGET, readProjectTarget } from "@lunora/codegen";
import type { ManifestConfigShape } from "@lunora/config/cloudflare";
import { buildBindingManifest, findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import type { Finding } from "./handler";

/** Metered products, by the binding type that enables them in wrangler config. */
const METERED_BINDINGS: Readonly<Record<string, string>> = {
    ai: "Workers AI",
    browser: "Browser Rendering",
    images: "Cloudflare Images (Image Transformations)",
};

/**
 * Paid products whose enablement is a zone or account dashboard setting. No
 * binding in wrangler config reveals them and no endpoint in the Cloudflare
 * client reads them, so they are reported as unknown rather than guessed at.
 */
const UNREADABLE_PRODUCTS: ReadonlyArray<string> = ["Argo Smart Routing", "Log Explorer"];

type WranglerWithEnvironments = ManifestConfigShape & { env?: Record<string, ManifestConfigShape | null | undefined> };

/** Which metered binding types are declared, and in which scope (`top level` or `env.<name>`). */
const declaredMetered = (parsed: WranglerWithEnvironments): Map<string, string[]> => {
    const scopes: [string, ManifestConfigShape][] = [
        ["top level", parsed],
        ...Object.entries(parsed.env ?? {}).flatMap(([name, block]): [string, ManifestConfigShape][] => (block ? [[`env.${name}`, block]] : [])),
    ];
    const declared = new Map<string, string[]>();

    for (const [scope, block] of scopes) {
        for (const requirement of buildBindingManifest(block).bindings) {
            if (METERED_BINDINGS[requirement.type] !== undefined) {
                declared.set(requirement.type, [...(declared.get(requirement.type) ?? []), scope]);
            }
        }
    }

    return declared;
};

/**
 * INFO (`paid-product-bound`) for each metered product whose binding is
 * declared; INFO (`paid-product-unknown`) naming the paid products lunora cannot
 * read. A project with no wrangler config, or on a non-Cloudflare target, is
 * skipped.
 */
const checkPaidProducts = (cwd: string, findings: Finding[]): void => {
    if ((readProjectTarget(cwd) ?? DEFAULT_TARGET) !== "cloudflare") {
        return;
    }

    const path = findWranglerFile(cwd);
    const parsed = path === undefined ? undefined : readWranglerJsonc<WranglerWithEnvironments>(path).parsed;

    if (parsed !== undefined) {
        for (const [type, scopes] of declaredMetered(parsed)) {
            const product = METERED_BINDINGS[type] ?? type;

            findings.push({
                code: "paid-product-bound",
                fix: "Create an account budget alert in the dashboard: Manage Account > Billing > Billable Usage > Create budget alert. Lunora cannot create or read one.",
                level: "info",
                message: `${product} is bound (${scopes.join(", ")}) and billed per use. No documented usage-alert product covers it, and lunora cannot read budget alerts, so an account budget alert is the only cap.`,
            });
        }
    }

    findings.push({
        code: "paid-product-unknown",
        level: "info",
        message: `enablement of ${UNREADABLE_PRODUCTS.join(" and ")} cannot be read by lunora (dashboard settings); check the dashboard if your account uses ${UNREADABLE_PRODUCTS.length > 1 ? "them" : "it"}.`,
    });
};

export default checkPaidProducts;
