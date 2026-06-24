import { describe, expect, it, vi } from "vitest";

import type { OfferDeps, StackFeature } from "../../src/commands/init/offer-extras";
import { offerRegistryExtras } from "../../src/commands/init/offer-extras";
import type { RegistryManifest } from "../../src/commands/registry/types";
import type { Logger } from "../../src/util/logger";

const makeLogger = (): { lines: string[]; logger: Logger } => {
    const lines: string[] = [];
    const push =
        (prefix: string) =>
        (message: string): number =>
            lines.push(`${prefix}${message}`);

    return { lines, logger: { error: push("error: "), info: push("info: "), success: push("success: "), warn: push("warn: ") } };
};

/** Base deps with no-op prompts; individual tests override what they exercise. */
const baseDeps = (overrides: Partial<OfferDeps>): OfferDeps => {
    return {
        apply: async () => true,
        interactive: true,
        logger: makeLogger().logger,
        multiSelect: async () => [],
        projectName: "lunora-app",
        select: async () => "auth",
        text: async () => "",
        ...overrides,
    };
};

describe("offerRegistryExtras", () => {
    it("prints a later-setup hint and applies nothing when non-interactive", async () => {
        expect.assertions(2);

        const apply = vi.fn<OfferDeps["apply"]>(async () => true);
        const { lines, logger } = makeLogger();

        await offerRegistryExtras(baseDeps({ apply, interactive: false, logger, multiSelect: async () => ["auth", "email"] }));

        expect(apply).not.toHaveBeenCalled();
        expect(lines.join("\n")).toMatch(/lunora add/);
    });

    it("applies the chosen auth provider and then email when both are selected", async () => {
        expect.assertions(1);

        const applied: string[][] = [];

        await offerRegistryExtras(
            baseDeps({
                apply: async (names) => {
                    applied.push([...names]);

                    return true;
                },
                multiSelect: async () => ["auth", "email"],
                select: async () => "auth-clerk",
            }),
        );

        expect(applied).toStrictEqual([["auth-clerk"], ["mail"]]);
    });

    it("applies only email when only email is selected", async () => {
        expect.assertions(1);

        const applied: string[][] = [];

        await offerRegistryExtras(
            baseDeps({
                apply: async (names) => {
                    applied.push([...names]);

                    return true;
                },
                multiSelect: async () => ["email"],
            }),
        );

        expect(applied).toStrictEqual([["mail"]]);
    });

    it("applies non-auth/email features as their registry item directly, in selection order", async () => {
        expect.assertions(1);

        const applied: string[][] = [];

        await offerRegistryExtras(
            baseDeps({
                apply: async (names) => {
                    applied.push([...names]);

                    return true;
                },
                multiSelect: async () => ["storage", "ratelimit", "crons", "presence", "backup"],
            }),
        );

        // No sub-prompt for these — the picked value IS the registry item name.
        expect(applied).toStrictEqual([["storage"], ["ratelimit"], ["crons"], ["presence"], ["backup"]]);
    });

    it("applies nothing when the multi-select returns an empty selection", async () => {
        expect.assertions(1);

        const apply = vi.fn<OfferDeps["apply"]>(async () => true);

        await offerRegistryExtras(baseDeps({ apply, multiSelect: async () => [] as StackFeature[] }));

        expect(apply).not.toHaveBeenCalled();
    });

    it("falls back to the default auth item when the provider select returns undefined", async () => {
        expect.assertions(1);

        const applied: string[][] = [];

        await offerRegistryExtras(
            baseDeps({
                apply: async (names) => {
                    applied.push([...names]);

                    return true;
                },
                multiSelect: async () => ["auth"],
                select: async () => undefined,
            }),
        );

        expect(applied).toStrictEqual([["auth"]]);
    });

    /** The `storage` registry manifest as shipped — a placeholder R2 bucket name. */
    const storageManifest = (): RegistryManifest => {
        return {
            bindings: [{ path: ["r2_buckets"], value: [{ binding: "UPLOADS", bucket_name: "replace-me-uploads" }] }],
            files: [],
            name: "storage",
        };
    };

    it("prompts for a storage bucket name and rewrites the manifest binding with it", async () => {
        expect.assertions(3);

        let promptMessage = "";
        let promptDefault: string | undefined;
        let written: unknown;

        await offerRegistryExtras(
            baseDeps({
                apply: async (_names, applyOptions) => {
                    written = applyOptions?.transformManifest?.(storageManifest());

                    return true;
                },
                multiSelect: async () => ["storage"],
                projectName: "my-app",
                text: async (message, settings) => {
                    promptMessage = message;
                    promptDefault = settings?.default;

                    return "my-cool-bucket";
                },
            }),
        );

        expect(promptMessage).toMatch(/bucket/i);
        // Default seeded from the project name.
        expect(promptDefault).toBe("my-app-uploads");
        expect(written).toStrictEqual({
            bindings: [{ path: ["r2_buckets"], value: [{ binding: "UPLOADS", bucket_name: "my-cool-bucket" }] }],
            files: [],
            name: "storage",
        });
    });

    it("sanitizes an invalid typed bucket name into a wrangler-valid one", async () => {
        expect.assertions(1);

        let written: RegistryManifest | undefined;

        await offerRegistryExtras(
            baseDeps({
                apply: async (_names, applyOptions) => {
                    written = applyOptions?.transformManifest?.(storageManifest());

                    return true;
                },
                multiSelect: async () => ["storage"],
                // Uppercase + underscores + spaces — exactly what wrangler rejects.
                text: async () => "My_App Uploads!",
            }),
        );

        const entry = (written?.bindings?.[0]?.value as { bucket_name: string }[]).at(0)!;

        expect(entry.bucket_name).toBe("my-app-uploads");
    });

    it("falls back to the project-derived default when the typed name sanitizes to nothing", async () => {
        expect.assertions(1);

        let written: RegistryManifest | undefined;

        await offerRegistryExtras(
            baseDeps({
                apply: async (_names, applyOptions) => {
                    written = applyOptions?.transformManifest?.(storageManifest());

                    return true;
                },
                multiSelect: async () => ["storage"],
                projectName: "lunora-app",
                // Nothing salvageable — falls back to `<project>-uploads`.
                text: async () => "!!!",
            }),
        );

        const entry = (written?.bindings?.[0]?.value as { bucket_name: string }[]).at(0)!;

        expect(entry.bucket_name).toBe("lunora-app-uploads");
    });

    /** The `auth` manifest as shipped — a placeholder D1 database name + id. */
    const authManifest = (): RegistryManifest => {
        return {
            bindings: [{ path: ["d1_databases"], value: [{ binding: "DB", database_id: "<replace-with-d1-create-id>", database_name: "replace-me-db" }] }],
            files: [],
            name: "auth",
        };
    };

    /** The `mail` manifest as shipped — a placeholder send-email destination. */
    const mailManifest = (): RegistryManifest => {
        return {
            bindings: [{ path: ["send_email"], value: [{ destination_address: "REPLACE_ME@example.com", name: "SEND_EMAIL" }] }],
            files: [],
            name: "mail",
        };
    };

    it("prompts for a D1 database name on the base auth provider and rewrites the binding (id untouched)", async () => {
        expect.assertions(2);

        let written: RegistryManifest | undefined;
        let promptDefault: string | undefined;

        await offerRegistryExtras(
            baseDeps({
                apply: async (_names, applyOptions) => {
                    written = applyOptions?.transformManifest?.(authManifest());

                    return true;
                },
                multiSelect: async () => ["auth"],
                projectName: "my-app",
                select: async () => "auth",
                text: async (_message, settings) => {
                    promptDefault = settings?.default;

                    return "my-db";
                },
            }),
        );

        expect(promptDefault).toBe("my-app-db");
        expect(written?.bindings?.[0]?.value).toStrictEqual([{ binding: "DB", database_id: "<replace-with-d1-create-id>", database_name: "my-db" }]);
    });

    it("prompts for a D1 name on a hosted provider too (clerk pulls in base auth via requires)", async () => {
        expect.assertions(2);

        let appliedItem: string | undefined;
        let written: RegistryManifest | undefined;

        await offerRegistryExtras(
            baseDeps({
                apply: async (names, applyOptions) => {
                    [appliedItem] = names;
                    // The transform is passed to the apply of `auth-clerk`; runAddCommand
                    // expands `requires: ["auth"]` and applies it to the base auth manifest.
                    written = applyOptions?.transformManifest?.(authManifest());

                    return true;
                },
                multiSelect: async () => ["auth"],
                select: async () => "auth-clerk",
                text: async () => "clerk-db",
            }),
        );

        expect(appliedItem).toBe("auth-clerk");
        expect((written?.bindings?.[0]?.value as { database_name: string }[]).at(0)?.database_name).toBe("clerk-db");
    });

    it("prompts for a mail destination and rewrites the binding when a valid email is given", async () => {
        expect.assertions(1);

        let written: RegistryManifest | undefined;

        await offerRegistryExtras(
            baseDeps({
                apply: async (_names, applyOptions) => {
                    written = applyOptions?.transformManifest?.(mailManifest());

                    return true;
                },
                multiSelect: async () => ["email"],
                text: async () => "support@my-app.com",
            }),
        );

        expect(written?.bindings?.[0]?.value).toStrictEqual([{ destination_address: "support@my-app.com", name: "SEND_EMAIL" }]);
    });

    it("keeps the mail placeholder (no transform) on a blank or invalid destination", async () => {
        expect.assertions(2);

        const transformSeen: boolean[] = [];
        const { lines, logger } = makeLogger();

        // Blank → skip silently.
        await offerRegistryExtras(
            baseDeps({
                apply: async (_names, applyOptions) => {
                    transformSeen.push(applyOptions?.transformManifest !== undefined);

                    return true;
                },
                multiSelect: async () => ["email"],
                text: async () => "   ",
            }),
        );

        // Invalid → skip with a warning.
        await offerRegistryExtras(
            baseDeps({
                apply: async (_names, applyOptions) => {
                    transformSeen.push(applyOptions?.transformManifest !== undefined);

                    return true;
                },
                logger,
                multiSelect: async () => ["email"],
                text: async () => "not-an-email",
            }),
        );

        expect(transformSeen).toStrictEqual([false, false]);
        expect(lines.join("\n")).toMatch(/doesn't look like an email/);
    });
});
