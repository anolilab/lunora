import { DatabaseSync } from "node:sqlite";

import { oauthProvider } from "@better-auth/oauth-provider";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { withAuthAudit } from "../src/audit-hooks";
import { createAuth } from "../src/create-auth";
import type { SqlExecutor } from "../src/sql-store";

const SECRET = "x".repeat(32);

/** Rows the hook wrote, read straight from the audit table, oldest first. */
interface AuditRow {
    detail: string | null;
    event: string;
    outcome: string;
}

describe("an end-session request that only asks for confirmation records no logout", () => {
    it("writes no sign-out row for the confirmation page, which ends no session", async () => {
        expect.assertions(3);

        const sqlite = new DatabaseSync(":memory:");
        const executor: SqlExecutor = {
            all: (sql, parameters) => Promise.resolve(sqlite.prepare(sql).all(...(parameters as never[])) as Record<string, unknown>[]),
            run: (sql, parameters) => {
                sqlite.prepare(sql).run(...(parameters as never[]));

                return Promise.resolve();
            },
        };
        const auth = createAuth(
            withAuthAudit(
                {
                    baseURL: "http://localhost",
                    database: memoryAdapter({ account: [], rateLimit: [], session: [], twoFactor: [], user: [], verification: [] }),
                    emailAndPassword: { enabled: true },
                    hooks: {},
                    plugins: [jwt(), oauthProvider({ consentPage: "/consent", loginPage: "/sign-in" })],
                    secret: SECRET,
                },
                { executor },
            ),
        );

        const signUp = await auth.handler(
            new Request("http://localhost/api/auth/sign-up/email", {
                body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "correct horse battery staple" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        // A browser navigation with a live session: better-auth answers with the confirmation page and sets its cookie.
        const logout = await auth.handler(
            new Request("http://localhost/api/auth/oauth2/end-session", {
                headers: { accept: "text/html", cookie: signUp.headers.get("set-cookie") ?? "", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
                method: "GET",
                redirect: "manual",
            }),
        );
        const rows = sqlite.prepare("SELECT event, outcome, detail FROM __lunora_auth_audit__ ORDER BY seq").all() as unknown as AuditRow[];

        await expect(logout.text()).resolves.toContain("Confirm logout");
        expect(rows.map((row) => row.event)).toStrictEqual(["sign-up"]);
        expect(rows.some((row) => row.event === "sign-out")).toBe(false);
    });
});
