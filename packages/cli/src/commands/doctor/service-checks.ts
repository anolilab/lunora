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
                // This check reads only the service's wrangler config. A custom domain is often
                // attached outside it (Alchemy's `alchemy.run.ts`, the dashboard), so a
                // Worker can be publicly reachable here without this file showing a route. The
                // advice therefore never says the binding is the only way in: turning off
                // workers.dev is safe only when no public route exists, and internal auth stays.
                fix: `If ${service.name} has no public route (custom domain or route, including ones set outside ${service.wranglerPath}), set \`"workers_dev": false\`${where}. Keep its internal auth (HMAC) either way.`,
                level: "warn",
                message: `service ${service.name} (${service.worker}) has no route in its wrangler config and still serves on workers.dev${where}; a custom domain set elsewhere would also be public.`,
            });
        }
    }
};

export default checkServices;
