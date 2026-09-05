import { describe, expect, it, vi } from "vitest";

import type { FeatureApply, OfferDeps, StackFeature } from "../../src/commands/init/offer-extras";
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
        applyAll: async () => true,
        interactive: true,
        logger: makeLogger().logger,
        multiSelect: async () => [],
        projectName: "lunora-app",
        select: async () => "auth",
        text: async () => "",
        ...overrides,
    };
};

/** Capture the single `applyAll` batch the offer hands over (every feature, already prompted). */
const captureApplyAll = (): { applyAll: OfferDeps["applyAll"]; plans: () => ReadonlyArray<FeatureApply> } => {
    let captured: ReadonlyArray<FeatureApply> = [];

    return {
        applyAll: async (plans) => {
            captured = plans;

            return true;
        },
        plans: () => captured,
    };
};

describe("offerRegistryExtras", () => {
    it("prints a later-setup hint and applies nothing when non-interactive", async () => {
        expect.assertions(2);

        const applyAll = vi.fn<OfferDeps["applyAll"]>(async () => true);
        const { lines, logger } = makeLogger();

        await offerRegistryExtras(baseDeps({ applyAll, interactive: false, logger, multiSelect: async () => ["auth", "email"] }));

        expect(applyAll).not.toHaveBeenCalled();
        expect(lines.join("\n")).toMatch(/lunora add/);
    });

    it("applies the chosen auth provider and then email when both are selected", async () => {
        expect.assertions(1);

        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["auth", "email"],
                select: async () => "auth-clerk",
            }),
        );

        expect(plans().map((plan) => [...plan.names])).toStrictEqual([["auth-clerk"], ["mail"]]);
    });

    it("applies only email when only email is selected", async () => {
        expect.assertions(1);

        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["email"],
            }),
        );

        expect(plans().map((plan) => [...plan.names])).toStrictEqual([["mail"]]);
    });

    it("applies non-auth/email features as their registry item directly, in selection order", async () => {
        expect.assertions(1);

        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["storage", "payment", "crons", "presence", "backup"],
            }),
        );

        // No sub-prompt for these — the picked value IS the registry item name.
        expect(plans().map((plan) => [...plan.names])).toStrictEqual([["storage"], ["payment"], ["crons"], ["presence"], ["backup"]]);
    });

    it("applies nothing when the multi-select returns an empty selection", async () => {
        expect.assertions(1);

        const applyAll = vi.fn<OfferDeps["applyAll"]>(async () => true);

        await offerRegistryExtras(baseDeps({ applyAll, multiSelect: async () => [] as StackFeature[] }));

        expect(applyAll).not.toHaveBeenCalled();
    });

    it("falls back to the default auth item when the provider select returns undefined", async () => {
        expect.assertions(1);

        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["auth"],
                select: async () => undefined,
            }),
        );

        expect(plans().map((plan) => [...plan.names])).toStrictEqual([["auth"]]);
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
        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["storage"],
                projectName: "my-app",
                text: async (message, settings) => {
                    promptMessage = message;
                    promptDefault = settings?.default;

                    return "my-cool-bucket";
                },
            }),
        );

        const written = plans()[0]?.transformManifest?.(storageManifest());

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

        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["storage"],
                // Uppercase + underscores + spaces — exactly what wrangler rejects.
                text: async () => "My_App Uploads!",
            }),
        );

        const written = plans()[0]?.transformManifest?.(storageManifest());
        const entry = (written?.bindings?.[0]?.value as { bucket_name: string }[]).at(0)!;

        expect(entry.bucket_name).toBe("my-app-uploads");
    });

    it("falls back to the project-derived default when the typed name sanitizes to nothing", async () => {
        expect.assertions(1);

        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["storage"],
                projectName: "lunora-app",
                // Nothing salvageable — falls back to `<project>-uploads`.
                text: async () => "!!!",
            }),
        );

        const written = plans()[0]?.transformManifest?.(storageManifest());
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

        let promptDefault: string | undefined;
        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["auth"],
                projectName: "my-app",
                select: async () => "auth",
                text: async (_message, settings) => {
                    promptDefault = settings?.default;

                    return "my-db";
                },
            }),
        );

        const written = plans()[0]?.transformManifest?.(authManifest());

        expect(promptDefault).toBe("my-app-db");
        expect(written?.bindings?.[0]?.value).toStrictEqual([{ binding: "DB", database_id: "<replace-with-d1-create-id>", database_name: "my-db" }]);
    });

    it("prompts for a D1 name on a hosted provider too (clerk pulls in base auth via requires)", async () => {
        expect.assertions(2);

        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["auth"],
                select: async () => "auth-clerk",
                text: async () => "clerk-db",
            }),
        );

        // The transform is passed alongside the `auth-clerk` item; runAddCommand
        // expands `requires: ["auth"]` and applies it to the base auth manifest.
        const written = plans()[0]?.transformManifest?.(authManifest());

        expect(plans()[0]?.names[0]).toBe("auth-clerk");
        expect((written?.bindings?.[0]?.value as { database_name: string }[]).at(0)?.database_name).toBe("clerk-db");
    });

    it("prompts for a mail destination and rewrites the binding when a valid email is given", async () => {
        expect.assertions(1);

        const { applyAll, plans } = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll,
                multiSelect: async () => ["email"],
                text: async () => "support@my-app.com",
            }),
        );

        const written = plans()[0]?.transformManifest?.(mailManifest());

        expect(written?.bindings?.[0]?.value).toStrictEqual([{ destination_address: "support@my-app.com", name: "SEND_EMAIL" }]);
    });

    it("keeps the mail placeholder (no transform) on a blank or invalid destination", async () => {
        expect.assertions(2);

        const transformSeen: boolean[] = [];
        const { lines, logger } = makeLogger();

        // Blank → skip silently.
        const blank = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll: blank.applyAll,
                multiSelect: async () => ["email"],
                text: async () => "   ",
            }),
        );
        transformSeen.push(blank.plans()[0]?.transformManifest !== undefined);

        // Invalid → skip with a warning.
        const invalid = captureApplyAll();

        await offerRegistryExtras(
            baseDeps({
                applyAll: invalid.applyAll,
                logger,
                multiSelect: async () => ["email"],
                text: async () => "not-an-email",
            }),
        );
        transformSeen.push(invalid.plans()[0]?.transformManifest !== undefined);

        expect(transformSeen).toStrictEqual([false, false]);
        expect(lines.join("\n")).toMatch(/doesn't look like an email/);
    });

    describe("auth-ui in a project no port fits", () => {
        // `detectAuthUiItem` returns `undefined` AS THE REFUSAL for React Native —
        // `lunora add auth-ui` gates on it and refuses. Both offer paths used to
        // `?? "auth-ui-react"` past that, so `lunora init my-app -t expo --add
        // auth-ui` copied ~85 DOM files into an Expo project and exited 0.
        it("refuses a --add auth-ui instead of defaulting to the React payload, and fails the run", async () => {
            expect.assertions(3);

            const { applyAll, plans } = captureApplyAll();
            const { lines, logger } = makeLogger();

            const ok = await offerRegistryExtras(
                baseDeps({
                    applyAll,
                    logger,
                    preselected: ["auth-ui", "storage"] as ReadonlyArray<StackFeature>,
                    resolveAuthUiItem: () => undefined,
                }),
            );

            expect(ok).toBe(false);
            expect(plans().map((plan) => plan.label)).toStrictEqual(["storage"]);
            expect(lines.join("\n")).toMatch(/no React Native port/);
        });

        it("drops the interactive auth-ui pick instead of applying the React payload", async () => {
            expect.assertions(2);

            const { applyAll, plans } = captureApplyAll();
            const { lines, logger } = makeLogger();

            await offerRegistryExtras(
                baseDeps({
                    applyAll,
                    logger,
                    multiSelect: async () => ["auth-ui"],
                    resolveAuthUiItem: () => undefined,
                }),
            );

            expect(plans()).toStrictEqual([]);
            expect(lines.join("\n")).toMatch(/no React Native port/);
        });
    });
});
