import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HYPERDRIVE_PLACEHOLDER_ID } from "@lunora/config/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectionStringVariable, provisionDeployHyperdrive, provisionHyperdrive } from "../../src/commands/deploy/hyperdrive";
import type { Logger } from "../../src/util/logger";

const CREDENTIALS = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "token" };
const URL_VARIABLE = connectionStringVariable("HYPERDRIVE");

interface Recorded {
    errors: string[];
    logger: Logger;
    messages: string[];
}

const recordingLogger = (): Recorded => {
    const errors: string[] = [];
    const messages: string[] = [];
    const logger: Logger = {
        error: (message) => errors.push(message),
        info: (message) => messages.push(message),
        success: (message) => messages.push(message),
        warn: (message) => messages.push(message),
    };

    return { errors, logger, messages };
};

/** The Hyperdrive REST API: `configs` is what the list answers with, and a POST gets `created`. */
const hyperdriveApi = (configs: { id: string; name: string }[]) =>
    vi.fn<typeof globalThis.fetch>(async (_url, init) =>
        Response.json({ errors: [], result: init?.method === "POST" ? { id: "new-config-id" } : configs, success: true }),
    );

describe("hyperdrive on deploy", () => {
    let root: string;
    let wranglerPath: string;

    const writeWrangler = (config: unknown): void => {
        writeFileSync(wranglerPath, JSON.stringify(config, undefined, 4), "utf8");
    };
    const readWrangler = (): { env?: { staging?: { hyperdrive?: { id: string }[] } }; hyperdrive: { binding: string; id: string }[] } =>
        JSON.parse(readFileSync(wranglerPath, "utf8")) as never;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-deploy-hyperdrive-"));
        wranglerPath = join(root, "wrangler.jsonc");
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    describe(provisionHyperdrive, () => {
        it("creates the config from the connection string and writes its id back", async () => {
            expect.assertions(5);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "My App" });

            const api = hyperdriveApi([]);
            const { errors, logger, messages } = recordingLogger();
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://app%40corp:p%2Fss@db.example.com:6543/shop" },
                fetch: api,
                logger,
            });

            const post = api.mock.calls.find(([, init]) => init?.method === "POST");

            expect(result).toBeUndefined();
            expect(readWrangler().hyperdrive).toStrictEqual([{ binding: "HYPERDRIVE", id: "new-config-id" }]);
            expect(JSON.parse(post?.[1]?.body as string)).toStrictEqual({
                name: expect.stringMatching(/^my-app-hyperdrive-[0-9a-f]{6}$/u),
                origin: { database: "shop", host: "db.example.com", password: "p/ss", port: 6543, scheme: "postgres", user: "app@corp" },
            });
            expect(errors).toStrictEqual([]);
            // The password is sent to Cloudflare and nowhere else.
            expect(messages.join(" ")).not.toContain("p/ss");
        });

        it("reuses a config of the same name instead of creating a second one", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "app" });

            const api = hyperdriveApi([
                { id: "existing-id", name: "app-hyperdrive", origin: { database: "db", host: "h", port: 5432, scheme: "postgres", user: "u" } } as never,
            ]);

            await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(readWrangler().hyperdrive[0]?.id).toBe("existing-id");
            expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
            expect(api).toHaveBeenCalledTimes(2);
        });

        it("does nothing, and calls nothing, once the binding has a real id", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: "real-id" }] });

            const api = hyperdriveApi([]);

            await expect(provisionHyperdrive({ cwd: root, environment: CREDENTIALS, fetch: api, logger: recordingLogger().logger })).resolves.toBeUndefined();
            expect(api).not.toHaveBeenCalled();
        });

        it("blocks the deploy, naming the variable to set, when no connection string is given", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const api = hyperdriveApi([]);
            const result = await provisionHyperdrive({ cwd: root, environment: CREDENTIALS, fetch: api, logger: recordingLogger().logger });

            expect(result).toContain("LUNORA_HYPERDRIVE_URL");
            expect(api).not.toHaveBeenCalled();
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);
        });

        it("blocks the deploy when the connection string is not a database URL", async () => {
            expect.assertions(1);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            await expect(
                provisionHyperdrive({
                    cwd: root,
                    environment: { ...CREDENTIALS, [URL_VARIABLE]: "https://example.com/db" },
                    fetch: hyperdriveApi([]),
                    logger: recordingLogger().logger,
                }),
            ).resolves.toContain("LUNORA_HYPERDRIVE_URL");
        });

        it("blocks the deploy, naming the token, when there are no Cloudflare credentials", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const api = hyperdriveApi([]);
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("CLOUDFLARE_API_TOKEN");
            expect(api).not.toHaveBeenCalled();
        });

        it("blocks the deploy, leaving the placeholder, when Cloudflare refuses", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const refusing = vi.fn<typeof globalThis.fetch>(async () => Response.json({ errors: [], success: false }, { status: 403 }));
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: refusing,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("HTTP 403");
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);
        });

        it("takes the account from the --env block when it sets one", async () => {
            expect.assertions(1);

            writeWrangler({
                account_id: "top-account",
                env: { staging: { account_id: "staging-account", hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] } },
            });

            const api = hyperdriveApi([]);

            await provisionHyperdrive({
                cwd: root,
                environment: { CLOUDFLARE_API_TOKEN: "token", [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
                wranglerEnvironment: "staging",
            });

            expect(api.mock.calls[0]?.[0]).toBe("https://api.cloudflare.com/client/v4/accounts/staging-account/hyperdrive/configs");
        });

        it("provisions only the named environment's own array, never a top-level placeholder it does not inherit", async () => {
            expect.assertions(3);

            writeWrangler({ env: { staging: {} }, hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const api = hyperdriveApi([]);

            await expect(
                provisionHyperdrive({
                    cwd: root,
                    environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                    fetch: api,
                    logger: recordingLogger().logger,
                    wranglerEnvironment: "staging",
                }),
            ).resolves.toBeUndefined();
            expect(api).not.toHaveBeenCalled();
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);
        });

        it("names the config after the environment's Worker, so staging and production never share one", async () => {
            expect.assertions(2);

            writeWrangler({
                env: {
                    prod: { hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] },
                    staging: { hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] },
                },
                name: "app",
            });

            const names: string[] = [];

            for (const wranglerEnvironment of ["staging", "prod"]) {
                const api = hyperdriveApi([]);

                // eslint-disable-next-line no-await-in-loop -- sequential on purpose: the second deploy must not see the first's file edit
                await provisionHyperdrive({
                    cwd: root,
                    environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                    fetch: api,
                    logger: recordingLogger().logger,
                    wranglerEnvironment,
                });

                names.push((JSON.parse(api.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body as string) as { name: string }).name);
            }

            expect(names).toStrictEqual(["app-staging-hyperdrive", "app-prod-hyperdrive"]);
            expect(new Set(names).size).toBe(2);
        });

        it("refuses to reuse a config of the same name that reaches another database", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "app" });

            const api = vi.fn<typeof globalThis.fetch>(async () =>
                Response.json({
                    errors: [],
                    result: [
                        {
                            id: "other-id",
                            name: "app-hyperdrive",
                            origin: { database: "db", host: "someone-else.example.com", port: 5432, scheme: "postgres", user: "u" },
                        },
                    ],
                    success: true,
                }),
            );
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@mine.example.com/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("different origin, or one that can't be confirmed (host)");
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);
            expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
        });

        it("does not create when the listing reply has no result list, since absence is unproven", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const api = vi.fn<typeof globalThis.fetch>(async () => Response.json({ errors: [], success: true }));
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("no result list");
            expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
        });

        it("does not create when the listing runs past the pages it will read", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const api = vi.fn<typeof globalThis.fetch>(async () => Response.json({ errors: [], result: [], result_info: { total_pages: 500 }, success: true }));
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("can't be shown to be absent");
            expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
        });

        it("updates the reused config's credentials, so a rotated password reaches the deployed binding", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "app" });

            const api = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
                Response.json({
                    errors: [],
                    result:
                        init?.method === "PATCH"
                            ? { id: "existing-id" }
                            : [
                                  {
                                      id: "existing-id",
                                      name: "app-hyperdrive",
                                      origin: { database: "db", host: "h", port: 5432, scheme: "postgresql", user: "u" },
                                  },
                              ],
                    success: true,
                }),
            );

            await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:rotated@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            const patch = api.mock.calls.find(([, init]) => init?.method === "PATCH");

            expect(patch?.[0]).toBe("https://api.cloudflare.com/client/v4/accounts/acc/hyperdrive/configs/existing-id");
            expect(JSON.parse(patch?.[1]?.body as string)).toStrictEqual({
                origin: { database: "db", host: "h", password: "rotated", port: 5432, scheme: "postgres", user: "u" },
            });
            expect(readWrangler().hyperdrive[0]?.id).toBe("existing-id");
        });

        it("does not reuse a same-named config that speaks the other engine", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "app" });

            const api = hyperdriveApi([
                { id: "mysql-id", name: "app-hyperdrive", origin: { database: "db", host: "h", port: 5432, scheme: "mysql", user: "u" } } as never,
            ]);
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("(scheme)");
            expect(api.mock.calls.some(([, init]) => init?.method === "PATCH" || init?.method === "POST")).toBe(false);
        });

        it("follows the listing's pages to find a config on a later one, rather than creating a duplicate", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "app" });

            const mine = { id: "page-two-id", name: "app-hyperdrive", origin: { database: "db", host: "h", port: 5432, scheme: "postgres", user: "u" } };
            const api = vi.fn<typeof globalThis.fetch>(async (url, init) => {
                if (init?.method === "PATCH") {
                    return Response.json({ errors: [], result: mine, success: true });
                }

                return (url as string).includes("page=2")
                    ? Response.json({ errors: [], result: [mine], result_info: { page: 2, total_pages: 2 }, success: true })
                    : Response.json({ errors: [], result: [{ id: "other", name: "other" }], result_info: { page: 1, total_pages: 2 }, success: true });
            });

            await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(readWrangler().hyperdrive[0]?.id).toBe("page-two-id");
            expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
            expect(api.mock.calls.filter(([url]) => (url as string).includes("/configs?page=2"))).toHaveLength(1);
        });

        it("does not reuse a config whose origin the listing leaves out, since it can't be confirmed", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "app" });

            const api = hyperdriveApi([{ id: "unknown-origin", name: "app-hyperdrive" }]);
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("can't be confirmed");
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);
        });

        it("sends postgres as the engine for a postgresql:// connection string", async () => {
            expect.assertions(1);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "app" });

            const api = hyperdriveApi([]);

            await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgresql://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            const post = api.mock.calls.find(([, init]) => init?.method === "POST");

            expect((JSON.parse(post?.[1]?.body as string) as { origin: { scheme: string } }).origin.scheme).toBe("postgres");
        });

        it("says a set-but-unusable connection string is unusable, without echoing it, rather than asking for it to be set", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "redis://user:hunter2@h/db" }, // gitleaks:allow -- a placeholder, not a real secret
                fetch: hyperdriveApi([]),
                logger: recordingLogger().logger,
            });

            expect(result).toContain("is set but is not a usable connection string");
            expect(result).not.toContain("hunter2");
            expect(result).not.toContain("has no config yet");
        });

        it("blocks, rather than throws, on a connection string with invalid percent-encoding", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const api = hyperdriveApi([]);
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:100%@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("LUNORA_HYPERDRIVE_URL");
            expect(api).not.toHaveBeenCalled();
        });

        it("sends the engine's default port when the connection string has none", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const postgres = hyperdriveApi([]);

            await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@neon.example.com/db" },
                fetch: postgres,
                logger: recordingLogger().logger,
            });

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const mysql = hyperdriveApi([]);

            await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "mysql://u:p@db.example.com/db" },
                fetch: mysql,
                logger: recordingLogger().logger,
            });

            const port = (api: typeof postgres): unknown =>
                (JSON.parse(api.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body as string) as { origin: { port: number } }).origin.port;

            expect(port(postgres)).toBe(5432);
            expect(port(mysql)).toBe(3306);
        });

        it("keeps Worker names that differ only in punctuation apart, since cleaning would otherwise give them one config name", async () => {
            expect.assertions(2);

            const names: string[] = [];

            for (const name of ["billing_api", "billing-api"]) {
                writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name });

                const api = hyperdriveApi([]);

                // eslint-disable-next-line no-await-in-loop -- sequential on purpose: one file, rewritten between runs
                await provisionHyperdrive({
                    cwd: root,
                    environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                    fetch: api,
                    logger: recordingLogger().logger,
                });

                names.push((JSON.parse(api.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body as string) as { name: string }).name);
            }

            expect(new Set(names).size).toBe(2);
            expect(names.every((name) => name.length <= 32)).toBe(true);
        });

        it("keeps the submitted password and any URL out of a failure it reports", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name: "app" });

            const echoing = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
                init?.method === "POST"
                    ? Response.json(
                          { errors: [{ code: 1, message: "bad origin postgres://u:s3cretPass@h/db with password s3cretPass" }], success: false },
                          { status: 400 },
                      )
                    : Response.json({ errors: [], result: [], success: true }),
            );
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:s3cretPass@h/db" }, // gitleaks:allow -- a placeholder, not a real secret
                fetch: echoing,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("bad origin");
            expect(result).not.toContain("s3cretPass");
            expect(result).not.toContain("postgres://");
        });

        it("keeps two long Worker names that share a prefix apart, inside the 32-character limit", async () => {
            expect.assertions(3);

            const names: string[] = [];

            for (const name of ["a-very-long-worker-name-for-the-billing-service", "a-very-long-worker-name-for-the-billing-api"]) {
                writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }], name });

                const api = hyperdriveApi([]);

                // eslint-disable-next-line no-await-in-loop -- sequential on purpose: one file, rewritten between runs
                await provisionHyperdrive({
                    cwd: root,
                    environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                    fetch: api,
                    logger: recordingLogger().logger,
                });

                names.push((JSON.parse(api.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body as string) as { name: string }).name);
            }

            expect(names.every((name) => name.length <= 32)).toBe(true);
            expect(new Set(names).size).toBe(2);
            expect(names.every((name) => /^[a-z0-9-]+$/u.test(name))).toBe(true);
        });

        it("blocks two bindings that differ only in punctuation, since they would read one variable and share one config", async () => {
            expect.assertions(2);

            writeWrangler({
                hyperdrive: [
                    { binding: "MY-DB", id: HYPERDRIVE_PLACEHOLDER_ID },
                    { binding: "MY_DB", id: HYPERDRIVE_PLACEHOLDER_ID },
                ],
            });

            const api = hyperdriveApi([]);
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, LUNORA_MY_DB_URL: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("both read LUNORA_MY_DB_URL");
            expect(api).not.toHaveBeenCalled();
        });

        it("checks every binding before creating any, so a later gap leaves no config behind", async () => {
            expect.assertions(2);

            writeWrangler({
                hyperdrive: [
                    { binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID },
                    { binding: "ANALYTICS", id: HYPERDRIVE_PLACEHOLDER_ID },
                ],
            });

            const api = hyperdriveApi([]);
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toContain("LUNORA_ANALYTICS_URL");
            expect(api).not.toHaveBeenCalled();
        });

        it("records the first binding's id even when a later one's creation fails", async () => {
            expect.assertions(3);

            writeWrangler({
                hyperdrive: [
                    { binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID },
                    { binding: "ANALYTICS", id: HYPERDRIVE_PLACEHOLDER_ID },
                ],
                name: "app",
            });

            let posts = 0;
            const api = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
                if (init?.method !== "POST") {
                    return Response.json({ errors: [], result: [], success: true });
                }

                posts += 1;

                return posts === 1
                    ? Response.json({ errors: [], result: { id: "first-id" }, success: true })
                    : Response.json({ errors: [{ code: 2008, message: "Invalid origin host" }], success: false }, { status: 400 });
            });
            const result = await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db", LUNORA_ANALYTICS_URL: "postgres://u:p@bad/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(readWrangler().hyperdrive.map((entry) => entry.id)).toStrictEqual(["first-id", HYPERDRIVE_PLACEHOLDER_ID]);
            // Cloudflare's own reason is shown; the request, with its password, is not.
            expect(result).toContain("Invalid origin host");
            expect(result).not.toContain("u:p");
        });

        it("reads and writes the --env block's own array, since hyperdrive does not inherit", async () => {
            expect.assertions(2);

            writeWrangler({
                env: { staging: { hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] } },
                hyperdrive: [{ binding: "HYPERDRIVE", id: "top-level-id" }],
            });

            await provisionHyperdrive({
                cwd: root,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: hyperdriveApi([]),
                logger: recordingLogger().logger,
                wranglerEnvironment: "staging",
            });

            expect(readWrangler().env?.staging?.hyperdrive?.[0]?.id).toBe("new-config-id");
            expect(readWrangler().hyperdrive[0]?.id).toBe("top-level-id");
        });
    });

    describe(provisionDeployHyperdrive, () => {
        it("creates nothing for a target that is not Cloudflare", async () => {
            expect.assertions(1);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            await expect(provisionDeployHyperdrive(root, { logger: recordingLogger().logger }, "deploy", "celld")).resolves.toBeUndefined();
        });

        it("has the check phase of a real deploy stop on a missing connection string, not just warn, without any API call", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });
            vi.stubEnv(URL_VARIABLE, "");

            const fetchStub = vi.fn<typeof globalThis.fetch>();

            vi.stubGlobal("fetch", fetchStub);

            const { errors, logger } = recordingLogger();
            const result = await provisionDeployHyperdrive(root, { logger }, "deploy", "cloudflare", "check");

            expect(result).toContain("deploy blocked");
            expect(errors.join(" ")).toContain("LUNORA_HYPERDRIVE_URL");
            expect(fetchStub).not.toHaveBeenCalled();

            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
        });

        it("creates nothing in the check phase even when everything is in place", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });
            vi.stubEnv(URL_VARIABLE, "postgres://u:p@h/db");
            vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
            vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");

            const fetchStub = hyperdriveApi([]);

            vi.stubGlobal("fetch", fetchStub);

            const result = await provisionDeployHyperdrive(root, { logger: recordingLogger().logger }, "deploy", "cloudflare", "check");

            expect(result).toBeUndefined();
            expect(fetchStub).not.toHaveBeenCalled();
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);

            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
        });

        it("has a dry run warn about a missing connection string, so a build needs no production secrets, without any API call", async () => {
            expect.assertions(4);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });
            vi.stubEnv(URL_VARIABLE, "");

            const fetchStub = vi.fn<typeof globalThis.fetch>();

            vi.stubGlobal("fetch", fetchStub);

            const { errors, logger, messages } = recordingLogger();
            const result = await provisionDeployHyperdrive(root, { dryRun: true, logger }, "deploy", "cloudflare");

            expect(result).toBeUndefined();
            expect(errors).toStrictEqual([]);
            expect(fetchStub).not.toHaveBeenCalled();
            expect(messages.join(" ")).toContain("LUNORA_HYPERDRIVE_URL");

            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
        });

        it("makes no API call or file change on a dry run that has everything a real deploy needs", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });
            vi.stubEnv(URL_VARIABLE, "postgres://u:p@h/db");
            vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
            vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "acc");

            const fetchStub = hyperdriveApi([]);

            vi.stubGlobal("fetch", fetchStub);

            const result = await provisionDeployHyperdrive(root, { dryRun: true, logger: recordingLogger().logger }, "deploy", "cloudflare");

            expect(result).toBeUndefined();
            expect(fetchStub).not.toHaveBeenCalled();
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);

            vi.unstubAllGlobals();
            vi.unstubAllEnvs();
        });

        it("lets a dry run through, creating nothing, once the connection string and credentials are there", async () => {
            expect.assertions(3);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const api = hyperdriveApi([]);
            const result = await provisionHyperdrive({
                cwd: root,
                dryRun: true,
                environment: { ...CREDENTIALS, [URL_VARIABLE]: "postgres://u:p@h/db" },
                fetch: api,
                logger: recordingLogger().logger,
            });

            expect(result).toBeUndefined();
            expect(api).not.toHaveBeenCalled();
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);
        });

        it("blocks prepare while the placeholder is there, without creating anything", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const result = await provisionDeployHyperdrive(root, { logger: recordingLogger().logger }, "prepare", "cloudflare");

            expect(result).toContain("prepare blocked");
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);
        });

        it("lets prepare through once the binding has a real id", async () => {
            expect.assertions(1);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: "real-id" }] });

            await expect(provisionDeployHyperdrive(root, { logger: recordingLogger().logger }, "prepare", "cloudflare")).resolves.toBeUndefined();
        });

        it("blocks a --temporary deploy while a Hyperdrive config would have to be made in the real account", async () => {
            expect.assertions(2);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            const result = await provisionDeployHyperdrive(root, { logger: recordingLogger().logger, temporary: true }, "deploy", "cloudflare");

            expect(result).toContain("--temporary");
            expect(readWrangler().hyperdrive[0]?.id).toBe(HYPERDRIVE_PLACEHOLDER_ID);
        });

        it("lets a --temporary deploy through when no Hyperdrive config is needed", async () => {
            expect.assertions(1);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: "real-id" }] });

            await expect(
                provisionDeployHyperdrive(root, { logger: recordingLogger().logger, temporary: true }, "deploy", "cloudflare"),
            ).resolves.toBeUndefined();
        });

        it("blocks a real Cloudflare deploy that has a placeholder and no connection string", async () => {
            expect.assertions(1);

            writeWrangler({ hyperdrive: [{ binding: "HYPERDRIVE", id: HYPERDRIVE_PLACEHOLDER_ID }] });

            vi.stubEnv(URL_VARIABLE, "");

            await expect(provisionDeployHyperdrive(root, { logger: recordingLogger().logger }, "deploy", "cloudflare")).resolves.toContain(
                "LUNORA_HYPERDRIVE_URL",
            );

            vi.unstubAllEnvs();
        });
    });
});
