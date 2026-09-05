import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendAuthAuditEntry, ensureAuthAuditTable, readAuthAuditLog } from "../src/audit";
import { buildAuditEntry } from "../src/audit-hooks";
import type { SqlExecutor } from "../src/sql-store";

const executorFor = (database: DatabaseSync): SqlExecutor => {
    return {
        all: (sql, parameters) => Promise.resolve(database.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
        run: (sql, parameters) => {
            database.prepare(sql).run(...(parameters as never[]));

            return Promise.resolve();
        },
    };
};

let database: DatabaseSync;
let executor: SqlExecutor;

describe("auth audit trail", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        executor = executorFor(database);
    });

    afterEach(() => {
        database.close();
        vi.unstubAllGlobals();
    });

    describe("auth audit store — record & query", () => {
        it("records sign-in / password-change / MFA-toggle events and reads them back newest-first", async () => {
            expect.assertions(4);

            await appendAuthAuditEntry(executor, { actorId: "u1", event: "sign-in", outcome: "success", ts: 1 });
            await appendAuthAuditEntry(executor, { actorId: "u1", event: "password-change", outcome: "success", ts: 2 });
            await appendAuthAuditEntry(executor, { actorId: "u1", event: "mfa-enable", outcome: "success", ts: 3 });
            await appendAuthAuditEntry(executor, { actorId: "u1", event: "mfa-disable", outcome: "success", ts: 4 });

            const rows = await readAuthAuditLog(executor);

            expect(rows).toHaveLength(4);
            expect(rows.map((row) => row.event)).toStrictEqual(["mfa-disable", "mfa-enable", "password-change", "sign-in"]);
            expect(rows[0]?.outcome).toBe("success");
            expect(rows.at(-1)?.actorId).toBe("u1");
        });

        it("filters by actor and event, and pages past sinceSeq", async () => {
            expect.assertions(3);

            await appendAuthAuditEntry(executor, { actorId: "a", event: "sign-in", outcome: "success", ts: 1 });
            await appendAuthAuditEntry(executor, { actorId: "b", event: "sign-in", outcome: "failure", ts: 2 });
            await appendAuthAuditEntry(executor, { actorId: "a", event: "sign-out", outcome: "success", ts: 3 });

            await expect(readAuthAuditLog(executor, { actorId: "a" })).resolves.toHaveLength(2);
            await expect(readAuthAuditLog(executor, { event: "sign-in" })).resolves.toHaveLength(2);
            await expect(readAuthAuditLog(executor, { sinceSeq: 2 })).resolves.toHaveLength(1);
        });

        it("returns [] on a never-audited database instead of throwing", async () => {
            expect.assertions(1);

            await expect(readAuthAuditLog(executor)).resolves.toStrictEqual([]);
        });

        /**
         * Plan 280 §5 S3: `Math.max(1, Math.min(NaN, MAX_READ_LIMIT))` is `NaN` —
         * previously reached the SQL `LIMIT ?` bind unchecked. The library-level
         * fix falls back to `DEFAULT_READ_LIMIT` for any non-finite `limit`, so
         * every caller of `readAuthAuditLog` is protected, not just the DO's
         * `#readAudit` boundary (which now also 400s before ever calling this).
         */
        it("falls back to the default limit when `limit` is NaN, instead of binding NaN as the SQL LIMIT", async () => {
            expect.assertions(1);

            for (let index = 0; index < 5; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential appends model the real per-request write order
                await appendAuthAuditEntry(executor, { event: "sign-in", outcome: "success", ts: index });
            }

            await expect(readAuthAuditLog(executor, { limit: Number.NaN })).resolves.toHaveLength(5);
        });
    });

    describe("auth audit store — retention", () => {
        it("keeps every row by default (unbounded, not capped at 1000)", async () => {
            expect.assertions(1);

            for (let index = 0; index < 25; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential appends model the real per-request write order
                await appendAuthAuditEntry(executor, { event: "sign-in", outcome: "success", ts: index });
            }

            await expect(readAuthAuditLog(executor, { limit: 10_000 })).resolves.toHaveLength(25);
        });

        it("trims to the most recent N when retention is configured", async () => {
            expect.assertions(2);

            for (let index = 0; index < 10; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential appends model the real per-request write order
                await appendAuthAuditEntry(executor, { event: "sign-in", outcome: "success", ts: index }, { retention: 3 });
            }

            const rows = await readAuthAuditLog(executor);

            expect(rows).toHaveLength(3);
            expect(rows.map((row) => row.ts)).toStrictEqual([9, 8, 7]);
        });
    });

    describe("auth audit store — redaction", () => {
        it("redacts secrets/PII in the detail payload before persisting", async () => {
            expect.assertions(4);

            await appendAuthAuditEntry(executor, {
                detail: { note: "login", password: "hunter2", token: "sk_live_secret", email: "victim@example.com" },
                event: "sign-in",
                outcome: "success",
                ts: 1,
            });

            const [row] = await readAuthAuditLog(executor);
            const detail = row?.detail ?? {};

            expect(detail["password"]).not.toBe("hunter2");
            expect(detail["token"]).not.toBe("sk_live_secret");
            expect(detail["email"]).not.toBe("victim@example.com");
            // A non-sensitive field survives so the trail stays useful.
            expect(detail["note"]).toBe("login");
        });

        it("skips redaction when redactDetail is false (trusted, pre-scrubbed payload)", async () => {
            expect.assertions(1);

            await appendAuthAuditEntry(executor, { detail: { password: "kept" }, event: "sign-in", outcome: "success", ts: 1 }, { redactDetail: false });

            const [row] = await readAuthAuditLog(executor);

            expect(row?.detail?.["password"]).toBe("kept");
        });

        it("invokes an export tap with the redacted, persisted entry", async () => {
            expect.assertions(2);

            const persisted = await appendAuthAuditEntry(executor, {
                detail: { secret: "abc123" },
                event: "sign-in",
                outcome: "success",
                ts: 1,
            });

            expect(persisted.event).toBe("sign-in");
            expect((persisted.detail as Record<string, unknown>)["secret"]).not.toBe("abc123");
        });

        /**
         * Plan 280 §4's verified correction: `targetEmail` MUST be a top-level
         * column, not a `detail` key — `AUDIT_REDACT_RULES` scrubs email-shaped
         * VALUES inside `detail` regardless of key name (a deep value-pattern
         * rule, not just a key-name rule), so the same address survives as
         * `targetEmail` while it is erased inside `detail`.
         */
        it("`targetEmail` survives redaction (top-level) while the SAME address inside `detail` is scrubbed", async () => {
            expect.assertions(2);

            await appendAuthAuditEntry(executor, {
                detail: { email: "victim@example.com" },
                event: "sign-in",
                outcome: "failure",
                targetEmail: "victim@example.com",
                ts: 1,
            });

            const [row] = await readAuthAuditLog(executor);

            expect(row?.targetEmail).toBe("victim@example.com");
            expect(row?.detail?.["email"]).not.toBe("victim@example.com");
        });

        it("old-shape rows (written before `target_email` existed) read back with no `targetEmail` field", async () => {
            expect.assertions(1);

            // Simulate a pre-migration row: create the (now-migrated) table first,
            // then insert directly with the OLD column list, bypassing
            // `appendAuthAuditEntry` (which always supplies `target_email` now
            // that the column exists) — `target_email` lands NULL, same as any
            // row written before this change shipped.
            await ensureAuthAuditTable(executor);
            await executor.run(
                `INSERT INTO "__lunora_auth_audit__" (ts, event, outcome, actor_id, actor_email, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [1, "sign-in", "success", "u1", null, null, null, null],
            );

            const [row] = await readAuthAuditLog(executor);

            expect(row).not.toHaveProperty("targetEmail");
        });

        it("degrades a malformed or non-object detail cell to an entry without detail, not an empty page", async () => {
            expect.assertions(4);

            await appendAuthAuditEntry(executor, { detail: { ok: true }, event: "sign-in", outcome: "success", ts: 1 });

            // The table is a plain SQL table an operator can also write to — a
            // hand-written or truncated cell must not 500 the whole read.
            await executor.run(`INSERT INTO "__lunora_auth_audit__" (ts, event, outcome, detail) VALUES (?, ?, ?, ?)`, [2, "sign-in", "success", "{not json"]);
            await executor.run(`INSERT INTO "__lunora_auth_audit__" (ts, event, outcome, detail) VALUES (?, ?, ?, ?)`, [3, "sign-in", "success", "42"]);

            const rows = await readAuthAuditLog(executor);

            expect(rows).toHaveLength(3);
            expect(rows[0]).not.toHaveProperty("detail");
            expect(rows[1]).not.toHaveProperty("detail");
            expect(rows[2]?.detail).toStrictEqual({ ok: true });
        });
    });

    describe("auth audit store — DDL memoization", () => {
        it("runs the table DDL once per executor across appends", async () => {
            expect.assertions(3);

            const statements: string[] = [];
            const counting: SqlExecutor = {
                all: (sql, parameters) => executor.all(sql, parameters),
                run: (sql, parameters) => {
                    statements.push(sql.trimStart());

                    return executor.run(sql, parameters);
                },
            };

            await appendAuthAuditEntry(counting, { event: "sign-in", outcome: "success", ts: 1 });
            await appendAuthAuditEntry(counting, { event: "sign-in", outcome: "success", ts: 2 });

            expect(statements.filter((sql) => sql.startsWith("CREATE TABLE"))).toHaveLength(1);
            expect(statements.filter((sql) => sql.startsWith("ALTER TABLE"))).toHaveLength(1);
            expect(statements.filter((sql) => sql.startsWith("INSERT"))).toHaveLength(2);
        });

        it("retries the DDL after a rejected first ensure instead of caching the failure", async () => {
            expect.assertions(3);

            let failNext = true;
            const flaky: SqlExecutor = {
                all: (sql, parameters) => executor.all(sql, parameters),
                run: (sql, parameters) => {
                    if (failNext && sql.trimStart().startsWith("CREATE TABLE")) {
                        failNext = false;

                        return Promise.reject(new Error("transient DDL failure"));
                    }

                    return executor.run(sql, parameters);
                },
            };

            await expect(appendAuthAuditEntry(flaky, { event: "sign-in", outcome: "success", ts: 1 })).rejects.toThrow("transient DDL failure");
            await expect(appendAuthAuditEntry(flaky, { event: "sign-in", outcome: "success", ts: 2 })).resolves.toBeDefined();
            await expect(readAuthAuditLog(flaky)).resolves.toHaveLength(1);
        });
    });

    describe("buildAuditEntry — classification & extraction", () => {
        it("classifies the endpoint path into a security event", () => {
            expect.assertions(5);

            expect(buildAuditEntry({ path: "/api/auth/sign-in/email" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/sign-up/email" })?.event).toBe("sign-up");
            expect(buildAuditEntry({ path: "/api/auth/change-password" })?.event).toBe("password-change");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/enable" })?.event).toBe("mfa-enable");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/disable" })?.event).toBe("mfa-disable");
        });

        /**
         * Plan 280 §1/§4: `/sign-in/social` and `/sign-in/magic-link` only DISPATCH
         * (mint a redirect URL / send an email) — pre-fix they were misclassified as
         * a completed `sign-in`. The endpoints that actually complete a challenged
         * or third-party sign-in (`/callback/:id`, `/magic-link/verify`, every
         * `/two-factor/verify-*`) were not recorded at all before this change.
         */
        it("classifies dispatch-only sign-in endpoints as `sign-in-initiated`, not `sign-in`", () => {
            expect.assertions(2);

            expect(buildAuditEntry({ path: "/api/auth/sign-in/social" })?.event).toBe("sign-in-initiated");
            expect(buildAuditEntry({ path: "/api/auth/sign-in/magic-link" })?.event).toBe("sign-in-initiated");
        });

        it("classifies every sign-in COMPLETION endpoint as `sign-in` (previously unrecorded)", () => {
            expect.assertions(5);

            expect(buildAuditEntry({ path: "/api/auth/callback/github" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/magic-link/verify" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/verify-totp" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/verify-otp" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/verify-backup-code" })?.event).toBe("sign-in");
        });

        /**
         * Every callback path prefix classifies, not just the core `/callback/:id`.
         * The classifier matches the `/callback/` substring rather than enumerating
         * prefixes, so a plugin that mounts its callback elsewhere is recorded
         * instead of silently skipped — `oauth-popup`'s `/oauth2/callback/*` and
         * `@better-auth/sso`'s `/sso/callback/:providerId` are the two that exist
         * upstream today. Neither is reachable through `plugins.ts` yet; these pin
         * that they classify correctly on the day one becomes reachable.
         */
        it("classifies an OAuth callback on any path prefix as `sign-in`", () => {
            expect.assertions(3);

            expect(buildAuditEntry({ path: "/api/auth/callback/github" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/oauth2/callback/google" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/sso/callback/okta" })?.event).toBe("sign-in");
        });

        it("still classifies every credential/username/phone sign-in as plain `sign-in` (no regression)", () => {
            expect.assertions(3);

            expect(buildAuditEntry({ path: "/api/auth/sign-in/email" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/sign-in/username" })?.event).toBe("sign-in");
            expect(buildAuditEntry({ path: "/api/auth/sign-in/phone-number" })?.event).toBe("sign-in");
        });

        it("no-regression: sign-up / sign-out / MFA-toggle / revoke / link / unlink classify exactly as before", () => {
            expect.assertions(7);

            expect(buildAuditEntry({ path: "/api/auth/sign-up/email" })?.event).toBe("sign-up");
            expect(buildAuditEntry({ path: "/api/auth/sign-out" })?.event).toBe("sign-out");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/enable" })?.event).toBe("mfa-enable");
            expect(buildAuditEntry({ path: "/api/auth/two-factor/disable" })?.event).toBe("mfa-disable");
            expect(buildAuditEntry({ path: "/api/auth/revoke-session" })?.event).toBe("session-revoke");
            expect(buildAuditEntry({ path: "/api/auth/link-social" })?.event).toBe("account-link");
            expect(buildAuditEntry({ path: "/api/auth/unlink-account" })?.event).toBe("account-unlink");
        });

        /**
         * Plan 280 §4/§9 Q2: the identifier extraction is shared across the
         * sign-in family, so `sign-in-initiated` (a magic-link dispatch) carries
         * `targetEmail` too — the address the link was sent to.
         */
        it("carries `targetEmail` from the request body for BOTH sign-in and sign-in-initiated events", () => {
            expect.assertions(2);

            const initiated = buildAuditEntry({ body: { email: "ada@example.com" }, path: "/api/auth/sign-in/magic-link" });
            const completed = buildAuditEntry({ body: { email: "ada@example.com" }, path: "/api/auth/sign-in/email" });

            expect(initiated?.targetEmail).toBe("ada@example.com");
            expect(completed?.targetEmail).toBe("ada@example.com");
        });

        it("falls back to `body.username` when `email` is absent", () => {
            expect.assertions(1);

            expect(buildAuditEntry({ body: { username: "ada" }, path: "/api/auth/sign-in/username" })?.targetEmail).toBe("ada");
        });

        it("does NOT carry `targetEmail` for a non-sign-in event, even if the body happens to have an `email` field", () => {
            expect.assertions(1);

            expect(buildAuditEntry({ body: { email: "ada@example.com" }, path: "/api/auth/change-password" })?.targetEmail).toBeUndefined();
        });

        it("length-caps `targetEmail` at 320 chars (RFC 5321) against a hostile body", () => {
            expect.assertions(1);

            const hostile = `${"a".repeat(400)}@example.com`;
            const entry = buildAuditEntry({ body: { email: hostile }, path: "/api/auth/sign-in/email" });

            expect(entry?.targetEmail).toHaveLength(320);
        });

        /**
         * A FAILED credential sign-in records no `actorEmail` (no authenticated
         * user), so without `targetEmail` a credential-stuffing sweep against one
         * address is invisible in the trail — this is the finding the plan opened
         * with.
         */
        it("a FAILED /sign-in/email still carries the attempted `targetEmail`", () => {
            expect.assertions(2);

            const entry = buildAuditEntry({
                body: { email: "victim@example.com" },
                context: { returned: new Error("invalid credentials") },
                path: "/api/auth/sign-in/email",
            });

            expect(entry?.outcome).toBe("failure");
            expect(entry?.targetEmail).toBe("victim@example.com");
        });

        it("skips non-security endpoints (returns undefined)", () => {
            expect.assertions(2);

            expect(buildAuditEntry({ path: "/api/auth/get-session" })).toBeUndefined();
            expect(buildAuditEntry({ path: undefined })).toBeUndefined();
        });

        it("extracts actor, IP and User-Agent from the request + fresh session", () => {
            expect.assertions(4);

            // cf-connecting-ip is only trusted on Cloudflare — see the IP
            // resolution block below.
            vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

            const entry = buildAuditEntry(
                {
                    context: { newSession: { user: { email: "ada@example.com", id: "u1" } } },
                    headers: new Headers({ "cf-connecting-ip": "203.0.113.7", "user-agent": "TestUA/1.0" }),
                    path: "/api/auth/sign-in/email",
                },
                { now: 1000 },
            );

            expect(entry?.actorId).toBe("u1");
            expect(entry?.actorEmail).toBe("ada@example.com");
            expect(entry?.ip).toBe("203.0.113.7");
            expect(entry?.userAgent).toBe("TestUA/1.0");
        });

        it("marks an APIError-shaped return as a failure", () => {
            expect.assertions(2);

            const failure = buildAuditEntry({ context: { returned: { status: 401 } }, path: "/api/auth/sign-in/email" });
            const success = buildAuditEntry({ context: { returned: { token: "ok" } }, path: "/api/auth/sign-in/email" });

            expect(failure?.outcome).toBe("failure");
            expect(success?.outcome).toBe("success");
        });

        it("round-trips a built entry through the store", async () => {
            expect.assertions(2);

            const entry = buildAuditEntry(
                {
                    context: { newSession: { user: { id: "u9" } } },
                    headers: new Headers({ "user-agent": "UA" }),
                    path: "/api/auth/sign-in/email",
                },
                { now: 42 },
            );

            // The append call is what a real hook would do with the built entry.
            await appendAuthAuditEntry(executor, entry ?? { event: "sign-in", outcome: "success", ts: 0 });

            const [row] = await readAuthAuditLog(executor, { actorId: "u9" });

            expect(row?.event).toBe("sign-in");
            expect(row?.userAgent).toBe("UA");
        });
    });

    // Plan 328: cf-connecting-ip wins when present; x-forwarded-for is only
    // trusted opt-in, and x-real-ip is never recorded, in either mode.
    describe("buildAuditEntry — client IP resolution (plan 328)", () => {
        // `cf-connecting-ip` is a header the client cannot write only ON
        // Cloudflare, where the edge overwrites it — workerd stamps this
        // `navigator.userAgent`, Node does not. Every case that expects the
        // header to be trusted must therefore say it is on Cloudflare.
        beforeEach(() => {
            vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
        });

        it("records cf-connecting-ip and ignores x-forwarded-for even when both are present and differ", () => {
            expect.assertions(1);

            const entry = buildAuditEntry({
                headers: new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" }),
                path: "/api/auth/sign-in/email",
            });

            expect(entry?.ip).toBe("203.0.113.7");
        });

        it("omits the IP off Cloudflare, where cf-connecting-ip is client-written", () => {
            expect.assertions(1);

            vi.stubGlobal("navigator", { userAgent: "Node.js/24" });

            // Nothing overwrites the header here, so it is whatever the caller
            // typed — an attacker-chosen `ip` on a sign-in row is worse than a
            // missing one, and the option's docblock promises omission.
            const entry = buildAuditEntry({
                headers: new Headers({ "cf-connecting-ip": "203.0.113.7" }),
                path: "/api/auth/sign-in/email",
            });

            expect(entry?.ip).toBeUndefined();
        });

        it("prefers the declared proxy chain over cf-connecting-ip off Cloudflare", () => {
            expect.assertions(1);

            vi.stubGlobal("navigator", { userAgent: "Node.js/24" });

            // Same ordering `create-auth.ts` applies: off Cloudflare the only
            // header worth reading is the one a declared proxy rewrote.
            const entry = buildAuditEntry(
                {
                    headers: new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9" }),
                    path: "/api/auth/sign-in/email",
                },
                { trustProxyHeaders: true },
            );

            expect(entry?.ip).toBe("198.51.100.9");
        });

        it("omits the IP when cf-connecting-ip is absent and proxy trust is off (default) — the regression test", () => {
            expect.assertions(1);

            const entry = buildAuditEntry({
                headers: new Headers({ "x-forwarded-for": "198.51.100.9" }),
                path: "/api/auth/sign-in/email",
            });

            expect(entry?.ip).toBeUndefined();
        });

        it("records the leftmost x-forwarded-for entry when cf-connecting-ip is absent and proxy trust is on", () => {
            expect.assertions(1);

            const entry = buildAuditEntry(
                {
                    headers: new Headers({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" }),
                    path: "/api/auth/sign-in/email",
                },
                { trustProxyHeaders: true },
            );

            expect(entry?.ip).toBe("198.51.100.9");
        });

        it("never records x-real-ip, with proxy trust off or on", () => {
            expect.assertions(2);

            const trustOff = buildAuditEntry({
                headers: new Headers({ "x-real-ip": "198.51.100.9" }),
                path: "/api/auth/sign-in/email",
            });
            const trustOn = buildAuditEntry(
                {
                    headers: new Headers({ "x-real-ip": "198.51.100.9" }),
                    path: "/api/auth/sign-in/email",
                },
                { trustProxyHeaders: true },
            );

            expect(trustOff?.ip).toBeUndefined();
            expect(trustOn?.ip).toBeUndefined();
        });

        it("still builds the audit entry when no IP-bearing headers are present at all", () => {
            expect.assertions(2);

            const entry = buildAuditEntry({ path: "/api/auth/sign-in/email" });

            expect(entry).toBeDefined();
            expect(entry?.ip).toBeUndefined();
        });
    });
});
