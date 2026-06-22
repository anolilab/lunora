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

/**
 * A feature offered in the post-scaffold multi-select. `auth`/`email` carry a
 * sub-prompt or alias; every other value IS the registry item name applied
 * directly (`storage` → the `storage` registry item, etc.).
 */
type StackFeature = "auth" | "backup" | "crons" | "email" | "presence" | "ratelimit" | "storage";

const STACK_FEATURE_OPTIONS: ReadonlyArray<{ description: string; label: string; value: StackFeature }> = [
    { description: "Sign-up / sign-in (asks which provider)", label: "Authentication", value: "auth" },
    { description: "Cloudflare Email Workers + a dev mail catcher", label: "Transactional email", value: "email" },
    { description: "Typed R2 buckets + signed URLs (@lunora/storage)", label: "File storage", value: "storage" },
    { description: "Token-bucket / sliding-window limits (@lunora/ratelimit)", label: "Rate limiting", value: "ratelimit" },
    { description: "Scheduled jobs via Cron Triggers (@lunora/scheduler)", label: "Cron jobs", value: "crons" },
    { description: "Live presence / who's-online over hibernated WebSockets", label: "Presence", value: "presence" },
    { description: "Snapshot + restore your Durable Object data", label: "Backups", value: "backup" },
];

interface OfferDeps {
    /** Apply one or more registry items into the new project; resolves `true` on success. */
    apply: (names: ReadonlyArray<string>) => Promise<boolean>;
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
 * Offer the stack features (auth, email, storage, rate limiting, crons,
 * presence, backups) in ONE multi-select after a successful scaffold. When auth
 * is picked, a follow-up single-select chooses the provider (email+password /
 * Clerk / Auth0); email maps to the `mail` item; every other feature value is
 * applied as its registry item directly. Picked items are applied in selection
 * order. Non-interactive: prints how to add them later and changes nothing.
 */
const offerRegistryExtras = async (deps: OfferDeps): Promise<void> => {
    if (!deps.interactive) {
        // eslint-disable-next-line no-secrets/no-secrets -- a pipe-separated feature list, not a secret
        deps.logger.info("tip: add features later with `lunora add <auth|email|storage|ratelimit|crons|presence|backup>`.");

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
            // `email` aliases the `mail` item; every other value IS its registry item name.
            // eslint-disable-next-line no-await-in-loop -- registry applies mutate shared files; keep them serial.
            await deps.apply([feature === "email" ? EMAIL_ITEM : feature]);
        }
    }
};

export { offerRegistryExtras, STACK_FEATURE_OPTIONS };
export type { OfferDeps, StackFeature };
