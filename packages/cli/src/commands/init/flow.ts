/**
 * The single seam that renders the `lunora init` badged transcript either way:
 * through `@visulima/tui` on a real TTY, or through the pail `LunoraReporter`
 * (`logStep`) off one. Prompts echo themselves (they take a `badge`), so this is
 * for the non-prompt lines — the opening step, the next-steps block, and Luna's
 * sign-off — keeping both render paths reading from `./theme`.
 */
import type { StepBadgeName } from "@lunora/config";
import { BADGES, isInteractive, LUNA_ART, LUNA_NAME, LUNA_SIGNOFF, paintAnswer } from "@lunora/config";

import type { Logger } from "../../util/logger";
import { logStep } from "../../util/logger";
import { tuiMascot, tuiStep } from "../../util/tui-prompts";

/**
 * Emit one badged step line. `answer`, when given, renders dimmed beneath the
 * message (one indented line each), matching the look prompts produce on submit.
 * A leading blank line separates each block (create-astro style) — on a TTY the
 * tui render adds it; off one we write it before the logged line.
 */
const emitStep = async (type: StepBadgeName, message: string, answer?: string): Promise<void> => {
    if (isInteractive()) {
        await tuiStep(BADGES[type], message, answer);

        return;
    }

    process.stdout.write("\n");

    if (answer === undefined || answer === "") {
        logStep(type, message);

        return;
    }

    const dimmed = answer
        .split("\n")
        .map((line) => paintAnswer(line))
        .join("\n");

    logStep(type, `${message}\n${dimmed}`);
};

/**
 * Sign off with Luna, the rabbit-in-the-moon mascot. On a TTY this is the tui art
 * block; off one it's the same ASCII through the logger so piped output still
 * gets the send-off.
 */
const emitMascot = async (logger: Logger): Promise<void> => {
    if (isInteractive()) {
        await tuiMascot();

        return;
    }

    logger.info(`\n${LUNA_ART}\n${LUNA_NAME}: ${LUNA_SIGNOFF}`);
};

export { emitMascot, emitStep };
