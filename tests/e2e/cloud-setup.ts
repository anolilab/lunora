import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Boot facts shared by `playwright.cloud.config.ts`, `cloud-seed.ts` and the
 * control-plane spec.
 *
 * The control plane is `apps/cloud` — a different app on a different origin from
 * the playground the main suite drives, so it gets its own config (the same split
 * `playwright.examples.config.ts` already makes for `examples/*`) rather than a
 * second server bolted into `globalSetup.ts`.
 */
const ROOT = new URL("../../", import.meta.url).pathname;

/** The control-plane app's workspace root. */
export const CLOUD_ROOT = join(ROOT, "apps/cloud");

/**
 * Its own port, not the app's default 5174: a developer's `pnpm --filter
 * @lunora/cloud run dev` (or the playground falling back off 5173) already owns
 * that one, and testing against an unknown, already-seeded database is the
 * failure mode `globalSetup.ts` learned to refuse.
 */
export const CLOUD_PORT = 5374;

export const CLOUD_BASE_URL = `http://localhost:${String(CLOUD_PORT)}`;

/** The account `apps/cloud/scripts/seed.ts` creates and prints; its published local defaults. */
export const DEV_EMAIL = "dev@lunora.local";
export const DEV_PASSWORD = "dev-password-1234"; // gitleaks:allow -- the seed's published local default, overridable there via LUNORA_SEED_PASSWORD

/**
 * Where the shared signed-in session lands.
 *
 * One sign-in per run, written by `cloud-seed.ts` and loaded by every test through
 * the config's `storageState`. Not a nicety: better-auth throttles `/sign-in/email`
 * per IP, and a suite that signs in once per test starts answering 429 at the fourth
 * one — a failure that looks like a broken test and is really a self-inflicted DoS.
 *
 * In the temp dir rather than the repo so nothing has to gitignore a credential.
 */
export const CLOUD_STORAGE_STATE = join(tmpdir(), "lunora-cloud-e2e-storage-state.json");

const DEV_VARS_PATH = join(CLOUD_ROOT, ".dev.vars");

/**
 * The two vars the worker refuses to boot without (`.dev.vars.example`):
 * `AUTH_SECRET` backs better-auth's sessions — without it EVERY route 500s with
 * "AUTH_SECRET is required" — and `LUNORA_ADMIN_TOKEN` gates `POST /v1/cells`,
 * which the seed needs before an organization can be placed on a cell.
 * `MAIL_FROM` keeps better-auth's send-on-sign-up verification mail from
 * throwing; in dev it is captured, not delivered.
 */
const DEV_VARS = `# Written by tests/e2e/cloud-setup.ts because none existed. Do not commit.
LUNORA_ADMIN_TOKEN="cloud-e2e-deterministic-admin-token"
AUTH_SECRET="cloud-e2e-deterministic-secret-do-not-use-in-prod"
MAIL_FROM="Lunora Cloud E2E <noreply@lunora.test>"
`;

/** Keys whose absence stops the worker booting at all — see {@link DEV_VARS}. */
const REQUIRED_KEYS = ["AUTH_SECRET", "LUNORA_ADMIN_TOKEN"];

/**
 * Why this suite cannot run here, or `undefined` when it can.
 *
 * Writes the deterministic `.dev.vars` first, but only if the app has none —
 * create-if-absent for the same reason `examples-setup.ts` gives: Vite watches
 * the file, this module is re-imported by every Playwright process, and a
 * write-then-restore cycle restarts the dev server mid-run. A developer's own
 * secrets are left alone; if theirs is missing a required key we skip rather
 * than overwrite it.
 */
export const cloudSkipReason = (): string | undefined => {
    if (!existsSync(join(CLOUD_ROOT, "package.json"))) {
        return "apps/cloud is not present in this checkout";
    }

    if (!existsSync(DEV_VARS_PATH)) {
        writeFileSync(DEV_VARS_PATH, DEV_VARS, "utf8");
    }

    const content = readFileSync(DEV_VARS_PATH, "utf8");
    const missing = REQUIRED_KEYS.filter((key) => !new RegExp(`^\\s*${key}\\s*=`, "m").test(content));

    if (missing.length > 0) {
        return `apps/cloud/.dev.vars is missing ${missing.join(" and ")} — the control-plane worker cannot boot without ${missing.length > 1 ? "them" : "it"}`;
    }

    return undefined;
};
