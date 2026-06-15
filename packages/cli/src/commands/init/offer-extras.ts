/**
 * The post-scaffold "which features do you want?" offer for `lunora init`.
 *
 * The multi-select, the auth-provider sub-select, and the registry apply step
 * are all injected ({@link OfferDeps}) so this logic is pure and unit-testable
 * without a TTY or the network: the CLI wires real readline prompts +
 * `runAddCommand`, tests pass fakes. Skipped entirely in a non-interactive
 * context (CI / `--yes` / no TTY) — it prints a one-line hint instead of
 * blocking automation.
 */
import type { Logger } from "../../util/logger";
import type { FeatureItem } from "../add/features";
import { EMAIL_ITEM, promptAuthProvider } from "../add/features";

/** A feature offered in the post-scaffold multi-select. `value` is the stack-feature key, not (yet) a registry item. */
type StackFeature = "auth" | "email";

const STACK_FEATURE_OPTIONS: ReadonlyArray<{ description: string; label: string; value: StackFeature }> = [
    { description: "Sign-up / sign-in (asks which provider)", label: "Authentication", value: "auth" },
    { description: "Cloudflare Email Workers + a dev mail catcher", label: "Transactional email", value: "email" },
];

interface OfferDeps {
    /** Apply one or more registry items into the new project; resolves `true` on success. */
    apply: (names: ReadonlyArray<FeatureItem>) => Promise<boolean>;
    /** When `false`, skip all prompts and print the later-setup hint. */
    interactive: boolean;
    logger: Logger;
    /** Multi-select among the stack features to add (TTY-backed in production). */
    multiSelect: (
        message: string,
        options: ReadonlyArray<{ description?: string; label: string; value: StackFeature }>,
        settings?: { defaults?: ReadonlyArray<StackFeature> },
    ) => Promise<StackFeature[]>;
    /** Single-select among the auth providers (TTY-backed in production). */
    select: (
        message: string,
        options: ReadonlyArray<{ description?: string; label: string; value: FeatureItem }>,
        settings?: { default?: FeatureItem },
    ) => Promise<FeatureItem | undefined>;
}

/**
 * Offer the stack features (authentication, transactional email) in ONE
 * multi-select after a successful scaffold. When auth is picked, a follow-up
 * single-select chooses the provider (email+password / Clerk / Auth0); email
 * maps to the `mail` item. Picked items are applied in selection order.
 * Non-interactive: prints how to add them later and changes nothing.
 */
const offerRegistryExtras = async (deps: OfferDeps): Promise<void> => {
    if (!deps.interactive) {
        deps.logger.info("tip: add authentication or email later with `lunora add auth` / `lunora add email`.");

        return;
    }

    const picked = await deps.multiSelect("Which features do you want to add?", STACK_FEATURE_OPTIONS, { defaults: [] });

    // Sequential by design: the auth-provider sub-prompt and each registry apply
    // both mutate shared project files (package.json, wrangler.jsonc) and prompt
    // the user one at a time — running them in parallel would interleave prompts
    // and race the file writes.
    for (const feature of picked) {
        if (feature === "auth") {
            // eslint-disable-next-line no-await-in-loop -- prompts/applies must run one at a time (see above).
            const provider = await promptAuthProvider(deps.select);

            // eslint-disable-next-line no-await-in-loop -- registry applies mutate shared files; keep them serial.
            await deps.apply([provider]);
        } else {
            // eslint-disable-next-line no-await-in-loop -- registry applies mutate shared files; keep them serial.
            await deps.apply([EMAIL_ITEM]);
        }
    }
};

export { offerRegistryExtras, STACK_FEATURE_OPTIONS };
export type { OfferDeps, StackFeature };
