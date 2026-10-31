import { describe, expect, it } from "vitest";

import { runAdminTokenCommand } from "../../src/commands/admin-token/handler";
import type { FetchLike } from "../../src/commands/run/handler";
import { EXIT_CODE } from "../../src/util/exit-code";
import type { Logger } from "../../src/util/logger";

const capturingLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];

    return {
        lines,
        logger: {
            error: (message: string) => lines.push(`error ${message}`),
            info: (message: string) => lines.push(`info ${message}`),
            success: (message: string) => lines.push(`success ${message}`),
            warn: (message: string) => lines.push(`warn ${message}`),
        },
    };
};

interface Call {
    body?: string;
    method?: string;
    url: string;
}

const answering =
    (result: unknown, status: number, calls: Call[]): FetchLike =>
    async (url, init) => {
        calls.push({ body: init?.body, method: init?.method, url });

        return { json: async () => result, ok: status < 300, status, text: async () => JSON.stringify(result) };
    };

const BASE = { token: "root", url: "http://localhost:8787" };

describe("lunora admin-token", () => {
    it("creates a token with an expiry and prints the secret once", async () => {
        expect.assertions(3);

        const calls: Call[] = [];
        const { lines, logger } = capturingLogger();
        const result = await runAdminTokenCommand({
            ...BASE,
            expiresDays: 2,
            fetchImpl: answering({ createdAt: 1, name: "ci", token: "lnat.ci.secret" }, 201, calls),
            logger,
            name: "ci",
            now: () => 1000,
            subcommand: "create",
        });

        expect(result.code).toBe(0);
        expect(calls).toStrictEqual([
            { body: JSON.stringify({ expiresAt: 1000 + 2 * 86_400_000, name: "ci" }), method: "POST", url: "http://localhost:8787/_lunora/admin/tokens" },
        ]);
        expect(lines).toContain("info lnat.ci.secret");
    });

    it("revokes by name and lists", async () => {
        expect.assertions(2);

        const calls: Call[] = [];
        const { logger } = capturingLogger();

        await runAdminTokenCommand({ ...BASE, fetchImpl: answering({ revoked: true }, 200, calls), logger, name: "ci", subcommand: "revoke" });
        await runAdminTokenCommand({ ...BASE, fetchImpl: answering({ tokens: [] }, 200, calls), logger, subcommand: "list" });

        expect(calls[0]).toMatchObject({ method: "DELETE", url: "http://localhost:8787/_lunora/admin/tokens?name=ci" });
        expect(calls[1]).toMatchObject({ method: "GET", url: "http://localhost:8787/_lunora/admin/tokens" });
    });

    it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])("refuses --expires-days %s before any request", async (expiresDays) => {
        expect.assertions(3);

        const calls: Call[] = [];
        const { lines, logger } = capturingLogger();
        const result = await runAdminTokenCommand({ ...BASE, expiresDays, fetchImpl: answering({}, 201, calls), logger, name: "ci", subcommand: "create" });

        expect(result.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(0);
        expect(lines).toContain("error --expires-days must be a positive number");
    });

    it("refuses a missing name before any request, and surfaces a 403", async () => {
        expect.assertions(3);

        const calls: Call[] = [];
        const { logger } = capturingLogger();
        const missing = await runAdminTokenCommand({ ...BASE, fetchImpl: answering({}, 200, calls), logger, subcommand: "revoke" });
        const refused = await runAdminTokenCommand({
            ...BASE,
            fetchImpl: answering({ error: { code: "ADMIN_ROOT_REQUIRED" } }, 403, calls),
            logger,
            subcommand: "list",
        });

        expect(missing.code).toBe(EXIT_CODE.USAGE);
        expect(calls).toHaveLength(1);
        expect(refused.code).not.toBe(0);
    });

    it("fails a create whose answer carries no token, instead of printing 'undefined' and exiting 0", async () => {
        expect.assertions(3);

        const { lines, logger } = capturingLogger();
        const result = await runAdminTokenCommand({
            ...BASE,
            fetchImpl: answering({ createdAt: 1, name: "ci" }, 201, []),
            logger,
            name: "ci",
            subcommand: "create",
        });

        expect(result.code).not.toBe(0);
        expect(lines.some((line) => line.includes("did not include the created token"))).toBe(true);
        expect(lines).not.toContain("info undefined");
    });

    it("marks a listed token whose row outlived its revocation", async () => {
        expect.assertions(2);

        const { lines, logger } = capturingLogger();
        const result = await runAdminTokenCommand({
            ...BASE,
            fetchImpl: answering(
                {
                    tokens: [
                        { createdAt: 1, name: "ci", revoked: true },
                        { createdAt: 2, name: "deploy" },
                    ],
                },
                200,
                [],
            ),
            logger,
            subcommand: "list",
        });

        expect(result.code).toBe(0);
        expect(lines.filter((line) => line.includes("ci ") && line.includes("revoked"))).toHaveLength(1);
    });
});
