/**
 * Stand up `templates/saas` for `playwright.saas.config.ts`: materialize it into
 * `.saas-app/` (a symlink farm over the workspace, since a template's `^0.0.0`
 * dependencies exist on no registry) and give it a deterministic `.dev.vars`.
 *
 * Rebuilt on every boot rather than reused, so a run always serves the template
 * as it is in this checkout — a stale copy would test yesterday's kit.
 *
 * Usage: node saas-app.mjs <port>
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { materializeTemplate } from "../../scripts/materialize-template.mjs";

const app = fileURLToPath(new URL(".saas-app", import.meta.url));
const port = process.argv[2];

if (!port) {
    throw new Error("usage: node saas-app.mjs <port>");
}

const origin = `http://localhost:${port}`;

rmSync(app, { force: true, recursive: true });
materializeTemplate("saas", app, { name: "lunora-saas-e2e" });

// `MAIL_FROM` routes better-auth's mail through `@lunora/mail`; `LUNORA_MAIL_CAPTURE`
// keeps it in the studio inbox, where the spec reads it back over the admin RPC
// with `LUNORA_ADMIN_TOKEN`. The admin token must match the spec's.
writeFileSync(
    join(app, ".dev.vars"),
    [
        `BETTER_AUTH_SECRET="saas-e2e-deterministic-secret-0123456789"`,
        `BETTER_AUTH_URL="${origin}"`,
        `APP_BASE_URL="${origin}"`,
        `MAIL_FROM="kit@lunora.test"`,
        `LUNORA_ADMIN_TOKEN="e2e-deterministic-admin-token"`,
        `LUNORA_MAIL_CAPTURE="1"`,
        "",
    ].join("\n"),
    "utf8",
);
