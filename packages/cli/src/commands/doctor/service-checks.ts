/**
 * `lunora doctor`'s service-binding check (plan 457). A Worker the app reaches
 * through a `services[]` binding needs no public URL, so a declared service
 * that still serves on `*.workers.dev` with no route of its own is open to the
 * internet for nothing — the default an HMAC-era service keeps.
 */
import { readServiceBindings } from "@lunora/codegen";

import type { Finding } from "./handler";

/**
 * WARN (`service-workers-dev`) for each declared service, and each of its
 * environments, that leaves `workers_dev` on (wrangler's default without
 * routes) and declares no route. A service with a route is public on purpose
 * and owns its own auth there. A declaration codegen rejects is codegen's to
 * report, so it is skipped here.
 */
const checkServices = (cwd: string, findings: Finding[]): void => {
    for (const service of readServiceBindings(cwd).services) {
        for (const scope of service.publicScopes) {
            const where = scope === "" ? "" : ` (env.${scope})`;

            findings.push({
                code: "service-workers-dev",
                fix: `Set \`"workers_dev": false\`${where} in ${service.wranglerPath} — the app's service binding is its only way in, so internal auth (HMAC) can go too.`,
                level: "warn",
                message: `service ${service.name} (${service.worker}) is bound by the app but still public on workers.dev${where}.`,
            });
        }
    }
};

export default checkServices;
