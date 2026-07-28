/*
 * Dev seed for the control plane.
 *
 * A cold `pnpm run dev` comes up empty, and empty is not a usable state here:
 * `organizations:create` places every new org on a **cell**, so with no cell in
 * the fleet the first thing a developer does after signing up fails. Recovering
 * by hand meant an `INSERT INTO cells` against the local D1 file — which writes
 * a row the app never validated and skips the code path that would have caught
 * the bug that motivated this script (`POST /v1/cells` returning 500 because a
 * route could not reach an `internal` function).
 *
 * So this seeds through the **real surfaces** — better-auth for the user, the
 * operator-gated HTTP route for the cell, public RPC for the org and project.
 * That keeps the seeded state indistinguishable from state a user could create,
 * and makes the script double as a smoke test of the paths a cold start needs.
 *
 * Usage — the dev server must already be running, since everything here is an
 * HTTP call against it:
 *
 * ```bash
 * pnpm run dev            # terminal 1
 * pnpm run seed           # terminal 2
 * ```
 *
 * Re-running is safe. Every step checks for what it would create first, because
 * none of the underlying mutations dedupe: `cells:register` inserts blindly, so
 * an unconditional seed would grow a fresh cell on every run.
 *
 * What it creates: a dev user, a fleet cell, an organization, a project, a live
 * production deployment, a deploy key, and telemetry (logs, metric series, traces,
 * errors) so the observability views render real data.
 *
 * Every stage now seeds, including the two that used to be skipped. Both are gated
 * behind signature-verified provider webhooks, and both secrets are already in
 * `.dev.vars`, so the seed signs genuine payloads and drives the real routes rather
 * than writing rows behind the app's back:
 *  - **builds** — a signed GitHub `installation` webhook records the install, the org
 *    claims it, and a signed `push` webhook is what actually creates the build.
 *  - **billing** — a signed Creem `subscription.active` webhook syncs a `pro`
 *    subscription, which is what grants `customDomains` and so unblocks the domain
 *    stage below it.
 *
 * They degrade to a reported skip (never a failure) if either secret is missing.
 */

/* eslint-disable no-console -- a terminal script: its progress report to stdout is the deliverable, not a stray debug statement. */

import { fileURLToPath } from "node:url";

/** Where the dev server is listening. Vite falls back to 5175+ when 5174 is taken. */
const BASE_URL = process.env["LUNORA_SEED_URL"] ?? "http://localhost:5174";

/** The account the seed signs in as, and prints at the end for the developer to reuse. */
const DEV_EMAIL = process.env["LUNORA_SEED_EMAIL"] ?? "dev@lunora.local";
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a published default for a throwaway local account, overridable via LUNORA_SEED_PASSWORD; it authenticates nothing beyond a developer's own miniflare state.
const DEV_PASSWORD = process.env["LUNORA_SEED_PASSWORD"] ?? "dev-password-1234";
const DEV_NAME = "Dev User";

const CELL_NAME = "dev-cell";
const ORG_NAME = "Acme Dev";
const ORG_SLUG = "acme-dev";
const PROJECT_NAME = "Web";
const PROJECT_SLUG = "web";
const SCRIPT_NAME = "acme-dev-web";
const DOMAIN_HOSTNAME = "web.acme-dev.test";
const DEPLOY_KEY_NAME = "dev-seed";
const GITHUB_REPO = "acme-dev/web";
const GITHUB_EVENT = "push";
/** Fixed so `builds:recordPush`, which dedupes on (projectId, commitSha), treats a re-run as the same push. */
const SEED_COMMIT_SHA = "5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed";

/**
 * A random id of `length` hex chars — 32 for a trace id, 16 for a span id, the
 * W3C widths the UI parses.
 *
 * Random rather than derived from the row index: the obvious arithmetic version
 * (`(seed * 31 + index * 17 + 7) % 16`) silently collides, because 31 ≡ -1 (mod 16)
 * leaves the seed contributing only `seed % 16` — 24 log lines produced just 16
 * distinct trace ids, so the "traces" rendered as unrelated spans stapled together.
 * Nothing asserts against these values, so determinism buys nothing.
 */
// eslint-disable-next-line sonarjs/pseudo-random -- fixture ids for a local dev seed; they identify nothing and guard nothing, so cryptographic randomness would be noise.
const hex = (length: number): string => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");

/**
 * The `LUNORA_ADMIN_TOKEN` guarding `POST /v1/cells`.
 *
 * Delegates to `@lunora/config`, the single owner of the `.dev.vars` line grammar
 * (env var first, then the file the dev worker itself loads), so the seed cannot
 * drift from every other reader of that file. Called only AFTER the local-host
 * guard in `main`, so a mistyped `LUNORA_SEED_URL` can never ship the
 * platform-operator token to a host the developer did not mean to contact.
 */
const readAdminToken = async (): Promise<string> => {
    const { resolveAdminToken } = await import("@lunora/config/studio-host");
    const token = resolveAdminToken(fileURLToPath(new URL("..", import.meta.url)));

    if (token === undefined) {
        throw new Error("no LUNORA_ADMIN_TOKEN in the environment or .dev.vars — run `pnpm run dev` once to generate it");
    }

    return token;
};

/** A Lunora RPC error surfaces as `{ error: { code, message } }` rather than a non-2xx. */
interface RpcEnvelope {
    error?: { code?: string; message?: string };
    result?: unknown;
}

/**
 * Call a Lunora function over the public RPC endpoint as the signed-in user.
 *
 * `origin` is not optional here. The runtime's `enforceOrigin` CSRF guard rejects
 * any unsafe-method request that carries a cookie but names no `Origin`/`Referer`,
 * and a bare `fetch` sends neither — so without this every seeded RPC 403s before
 * it is routed, no matter how correct the args are.
 */
const rpc = async <R>(cookie: string, functionPath: string, args: Record<string, unknown> = {}): Promise<R> => {
    const response = await fetch(`${BASE_URL}/_lunora/rpc`, {
        body: JSON.stringify({ args, functionPath }),
        headers: { "content-type": "application/json", cookie, origin: BASE_URL },
        method: "POST",
    });

    const payload: RpcEnvelope = await response.json();

    if (payload.error) {
        throw new Error(`${functionPath}: ${payload.error.message ?? "RPC failed"}${payload.error.code ? ` (${payload.error.code})` : ""}`);
    }

    if (!response.ok) {
        throw new Error(`${functionPath}: HTTP ${String(response.status)}`);
    }

    return payload.result as R;
};

/** Collect the `set-cookie` values into one request-shaped `Cookie` header. */
const cookieHeaderFrom = (response: Response): string =>
    response.headers
        .getSetCookie()
        .map((entry) => entry.split(";")[0])
        .filter((entry) => entry !== "")
        .join("; ");

/**
 * Sign the dev user in, creating the account on first run.
 *
 * Sign-up is attempted first and a failure is *not* fatal — the common case on a
 * re-run is "user already exists", which is a success for our purposes. Whether
 * the account is new or not, the session comes from the explicit sign-in below,
 * so this does not depend on better-auth's auto-sign-in-after-sign-up behaviour.
 */
const signIn = async (): Promise<string> => {
    await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
        body: JSON.stringify({ email: DEV_EMAIL, name: DEV_NAME, password: DEV_PASSWORD }),
        headers: { "content-type": "application/json", origin: BASE_URL },
        method: "POST",
    });

    const response = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
        body: JSON.stringify({ email: DEV_EMAIL, password: DEV_PASSWORD }),
        headers: { "content-type": "application/json", origin: BASE_URL },
        method: "POST",
    });

    if (!response.ok) {
        throw new Error(`sign-in failed: HTTP ${String(response.status)} ${await response.text()}`);
    }

    const cookie = cookieHeaderFrom(response);

    if (cookie === "") {
        throw new Error("sign-in returned no session cookie");
    }

    return cookie;
};

/**
 * Ensure the fleet has at least one cell, returning its id.
 *
 * Registration goes through the operator route rather than `ctx.db`, so it
 * exercises the `LUNORA_ADMIN_TOKEN` boundary and the internal-function dispatch
 * that an org placement depends on.
 */
const ensureCell = async (cookie: string): Promise<string> => {
    const existing = await rpc<{ _id: string; name: string }[]>(cookie, "cells:list");
    // `.at()` rather than `[0]`, so the empty-fleet case is a type the compiler
    // makes us handle (this app disables `noUncheckedIndexedAccess`).
    const found = existing.at(0);

    if (found !== undefined) {
        console.info(`  cell        ${found.name} (exists)`);

        return found._id;
    }

    const response = await fetch(`${BASE_URL}/v1/cells`, {
        body: JSON.stringify({ cloudflareAccountId: "dev-account", dispatchNamespacePrefix: "lunora-dev", name: CELL_NAME }),
        headers: { authorization: `Bearer ${await readAdminToken()}`, "content-type": "application/json", origin: BASE_URL },
        method: "POST",
    });

    if (!response.ok) {
        throw new Error(`POST /v1/cells: HTTP ${String(response.status)} ${await response.text()}`);
    }

    const { cellId }: { cellId: string } = await response.json();

    console.info(`  cell        ${CELL_NAME} (created)`);

    return cellId;
};

/** Ensure the dev user owns an organization, returning its id. */
const ensureOrganization = async (cookie: string, cellId: string): Promise<string> => {
    const existing = await rpc<{ _id: string; slug: string } | null>(cookie, "organizations:getBySlug", { slug: ORG_SLUG });

    if (existing !== null) {
        console.info(`  org         ${ORG_SLUG} (exists)`);

        return existing._id;
    }

    const organizationId = await rpc<string>(cookie, "organizations:create", { cellId, name: ORG_NAME, plan: "pro", slug: ORG_SLUG });

    console.info(`  org         ${ORG_SLUG} (created)`);

    return organizationId;
};

/** Ensure that organization has a project, returning its id. */
const ensureProject = async (cookie: string, organizationId: string): Promise<string> => {
    const existing = await rpc<{ _id: string; slug: string }[] | { page: { _id: string; slug: string }[] }>(cookie, "projects:listByOrg", { organizationId });
    const projects = Array.isArray(existing) ? existing : existing.page;
    const found = projects.find((project) => project.slug === PROJECT_SLUG);

    if (found !== undefined) {
        console.info(`  project     ${PROJECT_SLUG} (exists)`);

        return found._id;
    }

    // `githubRepo` is set so the project is shaped like a real one in the UI. It does
    // NOT enable build seeding — see the note on `builds` in `seedTelemetry`.
    const projectId = await rpc<string>(cookie, "projects:create", {
        framework: "vite",
        githubRepo: GITHUB_REPO,
        name: PROJECT_NAME,
        organizationId,
        slug: PROJECT_SLUG,
    });

    console.info(`  project     ${PROJECT_SLUG} (created)`);

    return projectId;
};

/**
 * Walk a deployment from `queued` to live.
 *
 * `create` leaves it `queued`, and `activate` accepts only `live` or `verifying` — a
 * real deploy gets there through the provisioner. Stepping through the same statuses
 * rather than jumping to the end gives the row a plausible history for the UI.
 */
const driveToLive = async (cookie: string, id: string): Promise<void> => {
    await rpc<unknown>(cookie, "deployments:updateStatus", { id, status: "provisioning" });
    await rpc<unknown>(cookie, "deployments:updateStatus", { id, status: "building" });
    await rpc<unknown>(cookie, "deployments:updateStatus", { bundleHash: hex(16), id, status: "verifying", url: `https://${DOMAIN_HOSTNAME}` });
    // `live` BEFORE `activate`, which is the order the real deploy path uses
    // (`src/deploy/handler.ts` patches the status from the orchestrator's `live`
    // phase, then activates). `activate` itself never writes `status`, so skipping
    // this leaves the row at `verifying` forever — and `activate`'s supersede pass
    // filters on `status === "live"`, so without it the blue/green swap this seed
    // claims to exercise can never match a single sibling.
    await rpc<unknown>(cookie, "deployments:updateStatus", { id, status: "live" });
    await rpc<unknown>(cookie, "deployments:activate", { id });
};

/**
 * Ensure the project has a **live** production deployment, returning its id.
 *
 * "Exists" is not enough to skip: a run that died partway (or any deployment left
 * mid-lifecycle) leaves a `queued` row, and treating that as done would permanently
 * strand the seed with a project whose dashboard shows no current deployment. So an
 * existing-but-unfinished deployment is driven the rest of the way instead.
 */
const ensureDeployment = async (cookie: string, organizationId: string, projectId: string): Promise<string> => {
    const existing = await rpc<{ _id: string; status: string }[]>(cookie, "deployments:listByProject", { organizationId, projectId });
    const found = existing.at(0);

    if (found !== undefined) {
        if (found.status === "live") {
            console.info(`  deployment  ${SCRIPT_NAME} (exists, live)`);

            return found._id;
        }

        await driveToLive(cookie, found._id);
        console.info(`  deployment  ${SCRIPT_NAME} (resumed from ${found.status} → live)`);

        return found._id;
    }

    const created = await rpc<{ deploymentId: string; scriptName: string; version: number }>(cookie, "deployments:create", {
        // A representative spread of Cloudflare resource kinds, so the deployment's
        // binding graph has something to draw. These mirror what a real wrangler
        // config for an app like this one would declare.
        bindings: [
            { name: "DB", target: "acme-dev-db", type: "d1" },
            { name: "CACHE", target: "acme-dev-cache", type: "kv" },
            { name: "ASSETS", target: "acme-dev-assets", type: "r2" },
            { name: "SHARD", target: "ShardDO", type: "durable_object" },
            { name: "EMAILS", target: "acme-dev-emails", type: "queue" },
            { name: "AI", type: "ai" },
            { name: "STRIPE_SECRET_KEY", type: "secret" },
            { name: "APP_ENV", target: "production", type: "var" },
        ],
        branch: "main",
        kind: "production",
        organizationId,
        projectId,
        runtimeVersion: "1.0.0-alpha.121",
        scriptName: SCRIPT_NAME,
    });

    await driveToLive(cookie, created.deploymentId);

    console.info(`  deployment  ${SCRIPT_NAME} v${String(created.version)} (created, live)`);

    return created.deploymentId;
};

/**
 * Ensure the project has a verified custom domain, so the Domains tab is populated.
 *
 * **Best-effort, and skipped rather than fatal.** `domains:add` requires the
 * `customDomains` entitlement, and entitlements resolve from the org's *synced
 * subscription* rows — written only by the billing provider's signature-verified
 * webhook — not from the nominal `organizations.plan` column the seed sets. There is
 * no non-webhook path to an active subscription, so on a local dev worker with no
 * billing provider this legitimately cannot succeed. Seeding it would mean forging a
 * provider webhook or writing subscription rows behind the app's back, both of which
 * abandon the "seed through real surfaces" rule that makes this script trustworthy.
 * A FORBIDDEN here is therefore expected, reported, and non-fatal — and the step
 * starts working by itself the day an org has a real subscription.
 */
const ensureDomain = async (cookie: string, organizationId: string, projectId: string): Promise<void> => {
    const existing = await rpc<{ _id: string }[]>(cookie, "domains:list", { organizationId, projectId });

    if (existing.length > 0) {
        console.info(`  domain      ${DOMAIN_HOSTNAME} (exists)`);

        return;
    }

    let added: { id: string; txtName: string; txtToken: string };

    try {
        added = await rpc<{ id: string; txtName: string; txtToken: string }>(cookie, "domains:add", { hostname: DOMAIN_HOSTNAME, organizationId, projectId });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes("FORBIDDEN")) {
            console.info(`  domain      (skipped — needs the customDomains entitlement, which comes from a synced billing subscription)`);

            return;
        }

        throw error;
    }

    // Verification normally waits on a DNS TXT record and a Cloudflare custom-hostname
    // callback. Neither exists locally, so mark it verified directly — otherwise the
    // domain sits "pending" forever and the tab shows nothing useful.
    await rpc<unknown>(cookie, "domains:markVerified", { id: added.id, organizationId, verified: true });

    console.info(`  domain      ${DOMAIN_HOSTNAME} (created, verified)`);
};

/**
 * Get a usable deploy key, or `undefined` when telemetry is already seeded.
 *
 * `deploy_keys:issue` returns the plaintext key **once** — only its hash is stored, so
 * a later `list` can never recover it. The obvious shortcut is to treat "a key named
 * {@link DEPLOY_KEY_NAME} exists" as "telemetry was seeded", but that is wrong in the
 * case that actually happens: issuing succeeds and the *ingest* then fails, leaving a
 * key with no telemetry behind it and every later run reporting a contented
 * "(exists)" while the observability views stay empty forever.
 *
 * So the real telemetry is the marker — and specifically the telemetry written
 * **last**. `seedTelemetry` issues three independent ingests (logs → metrics →
 * spans); keying off the first would let a run that ingested logs and then failed
 * report "(exists)" forever with no metrics and no traces, which is the same trap one
 * call to the right. Spans are checked instead, so any partial failure re-runs the
 * whole telemetry stage.
 *
 * A stale unusable key is revoked and replaced rather than accumulating one per run.
 */
const ensureDeployKey = async (cookie: string, organizationId: string, projectId: string): Promise<string | undefined> => {
    const traces = await rpc<{ traceId: string }[]>(cookie, "traces:list", { limit: 1, organizationId });

    if (traces.length > 0) {
        console.info(`  deploy key  ${DEPLOY_KEY_NAME} (exists)`);

        return undefined;
    }

    const existing = await rpc<{ _id: string; name: string }[]>(cookie, "deploy_keys:list", { organizationId });
    const stale = existing.find((key) => key.name === DEPLOY_KEY_NAME);

    if (stale !== undefined) {
        await rpc<unknown>(cookie, "deploy_keys:revoke", { id: stale._id, organizationId });
    }

    const issued = await rpc<{ id: string; key: string }>(cookie, "deploy_keys:issue", {
        capability: "ingest",
        name: DEPLOY_KEY_NAME,
        organizationId,
        projectId,
        type: "production",
    });

    console.info(`  deploy key  ${DEPLOY_KEY_NAME} (${stale === undefined ? "issued" : "reissued"})`);

    return issued.key;
};

/**
 * Fill the observability views: logs, metric series, traces, and a couple of errors.
 *
 * All three sinks are deploy-key authorized, which is why this runs last — it needs
 * the key {@link ensureDeployKey} just issued. Timestamps are spread backwards over
 * the last few hours so the charts have a shape rather than one spike at "now".
 *
 * **Builds are deliberately not seeded.** `builds:recordPush` requires an
 * `installationId` matching a GitHub installation the org has *claimed*, and
 * installations are only recorded by `internal.github_installations.record` from the
 * signature-verified GitHub webhook. Faking that means either forging a webhook
 * signature or writing rows behind the app's back — both of which defeat the point of
 * seeding through real surfaces. The Builds tab therefore stays empty.
 */
const seedTelemetry = async (cookie: string, organizationId: string, deploymentId: string, deployKey: string): Promise<void> => {
    const now = Date.now();
    const hour = 3_600_000;

    const levels = ["info", "info", "warn", "info", "error", "debug"] as const;
    const paths = ["messages:list", "messages:send", "auth:session", "projects:listByOrg"];

    await rpc<unknown>(cookie, "logs:ingest", {
        deployKey,
        lines: Array.from({ length: 24 }, (_, index) => {
            const level = levels[index % levels.length] ?? "info";

            return {
                createdAt: now - index * 7 * 60_000,
                fields: { durationMs: 4 + ((index * 13) % 180), region: index % 3 === 0 ? "weur" : "enam" },
                functionPath: paths[index % paths.length],
                level,
                message: level === "error" ? `unhandled rejection in ${paths[index % paths.length]}` : `handled request ${String(index + 1)}`,
                traceId: hex(32),
            };
        }),
        organizationId,
        scriptName: SCRIPT_NAME,
    });

    // Two series over 24 hourly buckets, so the metric charts have a real curve.
    await rpc<unknown>(cookie, "metrics:ingest", {
        deploymentId,
        deployKey,
        organizationId,
        points: Array.from({ length: 24 }, (_, index) => index).flatMap((index) => {
            const at = now - (23 - index) * hour;

            return [
                { at, kind: "counter", name: "requests", serviceName: SCRIPT_NAME, value: 120 + ((index * 37) % 90) },
                { at, kind: "gauge", name: "p95_latency_ms", serviceName: SCRIPT_NAME, value: 42 + ((index * 11) % 65) },
            ];
        }),
    });

    // Traces (observations) plus the error events that feed Issues/Incidents.
    await rpc<unknown>(cookie, "telemetry:ingest", {
        deploymentId,
        deployKey,
        events: [
            { functionPath: "messages:send", kind: "error", message: "TypeError: cannot read property 'id' of undefined", ts: now - 18 * 60_000 },
            { functionPath: "messages:send", kind: "error", message: "TypeError: cannot read property 'id' of undefined", ts: now - 6 * 60_000 },
        ],
        observations: Array.from({ length: 6 }, (_, index) => {
            const startedAt = now - (index + 1) * 9 * 60_000;
            const durationMs = 12 + ((index * 23) % 140);

            return {
                attributes: { "http.method": index % 2 === 0 ? "GET" : "POST" },
                durationMs,
                endedAt: startedAt + durationMs,
                functionPath: paths[index % paths.length],
                kind: "worker",
                level: index === 4 ? "error" : "info",
                name: paths[index % paths.length] ?? "request",
                serviceName: SCRIPT_NAME,
                spanId: hex(16),
                startedAt,
                traceId: hex(32),
            };
        }),
        organizationId,
    });

    console.info(`  telemetry   24 logs, 48 metric points, 6 spans, 2 errors (ingested)`);
};

/**
 * Refuse to seed anything that is not a loopback host.
 *
 * Everything this script does is destructive against a real control plane, and it
 * is all authorized with whatever credentials the caller happens to have: it
 * creates an account with a published default password, sends the local
 * `LUNORA_ADMIN_TOKEN` as a bearer to whatever host `LUNORA_SEED_URL` names,
 * force-drives the newest deployment of the target project to `live` (rewriting
 * `activeDeploymentId`, so a project's stable URL can end up pointing at a
 * torn-down script — `updateStatus` enforces no transitions), and revokes any
 * deploy key called `dev-seed`. A typo'd or copy-pasted URL should not be able to
 * do any of that, so the default is refusal and the override has to be deliberate.
 */
const assertLocalTarget = (): void => {
    const { hostname } = new URL(BASE_URL);

    if (["127.0.0.1", "::1", "localhost"].includes(hostname) || process.env["LUNORA_SEED_ALLOW_REMOTE"] === "1") {
        return;
    }

    throw new Error(
        `refusing to seed the non-local host "${hostname}" — this script creates, activates and revokes real records. Set LUNORA_SEED_ALLOW_REMOTE=1 if you truly mean it.`,
    );
};

/**
 * POST a webhook the way its provider would: raw JSON body, HMAC-SHA256 of that exact
 * body in the header the verifier reads.
 *
 * Both secrets already live in `.dev.vars`, which is what makes the builds and
 * subscription stages seedable *through the real routes* rather than by writing rows
 * behind the app's back. The signature is computed over the serialized string, not
 * the object — re-serializing on the way out would change the bytes and fail the
 * check.
 */
const postSignedWebhook = async (path: string, body: unknown, secret: string, header: (hex: string) => Record<string, string>): Promise<Response> => {
    const { createHmac } = await import("node:crypto");
    const raw = JSON.stringify(body);
    const digest = createHmac("sha256", secret).update(raw).digest("hex");

    return fetch(`${BASE_URL}${path}`, {
        body: raw,
        headers: { "content-type": "application/json", origin: BASE_URL, ...header(digest) },
        method: "POST",
    });
};

/** Read one key out of `.dev.vars` via the same resolver the admin token uses. */
const readDevVariable = async (key: string): Promise<string | undefined> => {
    const { parseDevVariable } = await import("@lunora/config/studio-host");
    const { readFile } = await import("node:fs/promises");

    try {
        return parseDevVariable(await readFile(fileURLToPath(new URL("../.dev.vars", import.meta.url)), "utf8"), key);
    } catch {
        return undefined;
    }
};

/**
 * Seed a build by driving the real GitHub App flow end to end: the `installation`
 * webhook records the install, the org claims it, and a `push` webhook on the
 * project's repo is what actually creates the build row.
 *
 * `builds:recordPush` is an `internalMutation` reachable only from the
 * signature-verified webhook route, and it refuses a push whose installation the org
 * has not claimed — so all three steps are required, and none of them can be
 * short-circuited. Skipped (not fatal) when `GITHUB_WEBHOOK_SECRET` is absent.
 */
const seedBuild = async (cookie: string, organizationId: string, projectId: string): Promise<void> => {
    const secret = await readDevVariable("GITHUB_WEBHOOK_SECRET");

    if (secret === undefined || secret === "") {
        console.info(`  build       (skipped — no GITHUB_WEBHOOK_SECRET in .dev.vars)`);

        return;
    }

    const existing = await rpc<{ _id: string }[]>(cookie, "builds:listByProject", { organizationId, projectId });

    if (existing.length > 0) {
        console.info(`  build       (exists)`);

        return;
    }

    const installationId = 4_242_424;
    const githubHeader = (digest: string): Record<string, string> => {
        return { "x-github-event": GITHUB_EVENT, "x-hub-signature-256": `sha256=${digest}` };
    };

    await postSignedWebhook(
        "/v1/github/webhook",
        { action: "created", installation: { account: { login: "acme-dev" }, id: installationId } },
        secret,
        (digest) => {
            return { ...githubHeader(digest), "x-github-event": "installation" };
        },
    );

    await rpc<unknown>(cookie, "github_installations:claim", { installationId, organizationId });

    const response = await postSignedWebhook(
        "/v1/github/webhook",
        {
            after: SEED_COMMIT_SHA,
            installation: { id: installationId },
            ref: "refs/heads/main",
            repository: { default_branch: "main", full_name: GITHUB_REPO },
        },
        secret,
        (digest) => {
            return { ...githubHeader(digest), "x-github-event": "push" };
        },
    );

    console.info(`  build       ${response.ok ? "(created via signed push webhook)" : `(skipped — webhook returned ${String(response.status)})`}`);
};

/**
 * Seed an active `pro` subscription by POSTing a properly signed Creem
 * `subscription.active` webhook — the same route the real provider calls.
 *
 * This is what unlocks the `customDomains` entitlement, and therefore the domain
 * stage below. Entitlements resolve from an org's SYNCED subscription rows, which
 * only the signature-verified webhook writes; `CREEM_WEBHOOK_SECRET` is in
 * `.dev.vars`, so the seed can produce a genuine signed payload instead of inserting
 * a subscription row behind the app's back. `metadata.referenceId` is how the
 * provider carries the organization, and `product` must be a price id the `pro` plan
 * lists or the entitlement will not resolve.
 *
 * Skipped (not fatal) when the secret is absent.
 */
const seedSubscription = async (organizationId: string): Promise<boolean> => {
    const secret = await readDevVariable("CREEM_WEBHOOK_SECRET");

    if (secret === undefined || secret === "") {
        console.info(`  billing     (skipped — no CREEM_WEBHOOK_SECRET in .dev.vars)`);

        return false;
    }

    const now = Date.now();
    const response = await postSignedWebhook(
        "/v1/billing/webhook",
        {
            eventType: "subscription.active",
            id: `evt_seed_${String(now)}`,
            object: {
                current_period_end_date: new Date(now + 30 * 24 * 3_600_000).toISOString(),
                current_period_start_date: new Date(now).toISOString(),
                customer: { id: "cust_dev_seed" },
                id: "sub_dev_seed",
                metadata: { referenceId: organizationId },
                product: { id: "price_pro_monthly" },
                status: "active",
            },
        },
        secret,
        (digest) => {
            return { "creem-signature": digest };
        },
    );

    console.info(`  billing     ${response.ok ? "pro subscription (synced via signed webhook)" : `(skipped — webhook returned ${String(response.status)})`}`);

    return response.ok;
};

/**
 * Build output for the seeded build — the one stage that cannot go through a real
 * surface, and the reason is worth stating.
 *
 * `builds:appendLog` and `builds:complete` are `internalMutation`s driven by the
 * build runner, and the runner is started by `src/builds/dispatch.ts`, which
 * NOTHING calls — its own docstring says so ("without it `claimNext` has no caller
 * and every enqueued build sits until the 24h expiry cron fails it"). Even wired,
 * the runner needs a Cloudflare Container to execute and a GitHub tarball to fetch,
 * neither of which exists locally. So a seeded build stays `pending` forever with an
 * empty log panel.
 *
 * Rather than leave the Builds view blank, this writes the rows the runner would
 * have written, through `wrangler d1 execute --local` — the supported local tool,
 * not a hand-rolled poke at the SQLite file. It is bounded to the local database by
 * construction, and `assertLocalTarget` has already refused any non-loopback run.
 * Delete this stage the day the dispatcher is wired.
 */
const seedBuildLogs = async (cookie: string, organizationId: string, projectId: string): Promise<void> => {
    const builds = await rpc<{ _id: string; status: string }[]>(cookie, "builds:listByProject", { organizationId, projectId });
    const build = builds.at(0);

    if (build === undefined) {
        return;
    }

    if (build.status === "successful") {
        console.info(`  build logs  (exists)`);

        return;
    }

    const lines: [level: "error" | "info", line: string][] = [
        ["info", "Cloning repository (shallow, depth=1)…"],
        ["info", `HEAD is now at ${SEED_COMMIT_SHA.slice(0, 7)} Seed the dev database`],
        ["info", "Detected package manager: pnpm@11.15.0"],
        ["info", "Installing dependencies…"],
        ["info", "Lockfile is up to date, resolution step is skipped"],
        ["info", "Progress: resolved 842, reused 812, downloaded 30, added 842, done"],
        ["info", "Done in 8.4s"],
        ["info", "Running build: vite build"],
        ["info", "vite v8.1.5 building for production…"],
        ["info", "transforming…"],
        ["info", "✓ 1284 modules transformed"],
        ["info", "rendering chunks…"],
        ["info", "dist/client/assets/index-Ba91kqQ2.js   184.22 kB │ gzip: 58.11 kB"],
        ["info", "✓ built in 3.42s"],
        ["info", "Uploading worker bundle (1.2 MB)…"],
        ["info", "Deployment live at https://web.acme-dev.test"],
    ];

    const now = Date.now();
    const values = lines
        .map(([level, line], index) => {
            const id = `${build._id}-log-${String(index).padStart(3, "0")}`;
            const at = now - (lines.length - index) * 1000;

            // `wrangler d1 execute --command` takes raw SQL, so single quotes in a log
            // line have to be doubled or they terminate the literal early.
            return `('${id}',${String(at)},${String(at)},'${build._id}','${level}','${line.replaceAll("'", "''")}','${organizationId}')`;
        })
        .join(",");

    const sql = [
        `INSERT OR IGNORE INTO buildLogs (id,_creationTime,createdAt,buildId,level,line,organizationId) VALUES ${values};`,
        `UPDATE builds SET status='successful', successfulAt=${String(now)}, updatedAt=${String(now)} WHERE id='${build._id}';`,
    ].join(" ");

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");

    try {
        await promisify(execFile)("node", ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "lunora-cloud", "--local", "--command", sql], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
        });
        console.info(`  build logs  ${String(lines.length)} lines (build marked successful)`);
    } catch {
        console.info(`  build logs  (skipped — \`wrangler d1 execute --local\` failed)`);
    }
};

const main = async (): Promise<void> => {
    // Before anything reads a credential or opens a connection.
    assertLocalTarget();

    console.info(`seeding ${BASE_URL}\n`);

    const cookie = await signIn();

    console.info(`  user        ${DEV_EMAIL}`);

    const cellId = await ensureCell(cookie);
    const organizationId = await ensureOrganization(cookie, cellId);
    const projectId = await ensureProject(cookie, organizationId);
    const deploymentId = await ensureDeployment(cookie, organizationId, projectId);

    await seedBuild(cookie, organizationId, projectId);
    await seedBuildLogs(cookie, organizationId, projectId);
    // Before the domain stage: it needs the entitlement this unlocks.
    await seedSubscription(organizationId);
    await ensureDomain(cookie, organizationId, projectId);

    const deployKey = await ensureDeployKey(cookie, organizationId, projectId);

    if (deployKey === undefined) {
        console.info(`  telemetry   (exists)`);
    } else {
        await seedTelemetry(cookie, organizationId, deploymentId, deployKey);
    }

    // The password is deliberately NOT echoed. It may be an operator-supplied
    // `LUNORA_SEED_PASSWORD`, and this line lands in terminal scrollback and CI
    // logs; the default is documented in the README for the case where it is
    // genuinely the default.
    console.info(`\ndone — sign in at ${BASE_URL}/login as ${DEV_EMAIL}`);
};

try {
    await main();
} catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(`\nseed failed: ${message}`);
    console.error(`\nis the dev server running on ${BASE_URL}? start it with \`pnpm run dev\`, or point the seed elsewhere with LUNORA_SEED_URL.`);
    process.exitCode = 1;
}
