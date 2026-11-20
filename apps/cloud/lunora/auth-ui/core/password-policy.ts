/**
 * The password rules, and the live feedback that shows them being met.
 *
 * # Why the policy is configurable
 *
 * The rule that matters is the server's — better-auth rejects what it rejects,
 * and `emailAndPassword.minPasswordLength` is set there. A UI with its own
 * hard-coded minimum is guessing: set it lower and the user is told "too short"
 * only after a round-trip; set it higher and you refuse passwords the server
 * would have accepted. Neither is a validation bug you can see in a screenshot,
 * which is why it stays wrong for a long time.
 *
 * So {@link PasswordPolicy} exists to be matched to the server's, and
 * {@link DEFAULT_PASSWORD_POLICY} is only a floor that agrees with better-auth's
 * own default of 8.
 *
 * # Why the meter reports requirements, not a score
 *
 * A bare "weak / strong" bar tells someone their password is unacceptable
 * without telling them what to change, so they add another `!` and try again.
 * {@link passwordRequirements} returns each rule with whether it is met; the
 * score is derived from that for the bar, not the other way round.
 */
import type { Localization } from "./localization";

/** Password rules, meant to mirror what the server enforces. */
interface PasswordPolicy {
    /** Reject anything longer. better-auth's own default cap is 128. */
    maxLength?: number;
    /** Reject anything shorter. Defaults to 8, matching better-auth. */
    minLength?: number;
    /** Require at least one digit. */
    requireDigit?: boolean;
    /** Require at least one lowercase letter. */
    requireLowercase?: boolean;
    /** Require at least one character that is not a letter or digit. */
    requireSymbol?: boolean;
    /** Require at least one uppercase letter. */
    requireUppercase?: boolean;
}

/** better-auth's own defaults: a length floor and nothing else. */
const DEFAULT_PASSWORD_POLICY: Required<Pick<PasswordPolicy, "maxLength" | "minLength">> = { maxLength: 128, minLength: 8 };

/** One rule and whether the current value satisfies it. */
interface PasswordRequirement {
    label: string;
    met: boolean;
}

const DIGIT = /\d/u;
const LOWERCASE = /\p{Ll}/u;
const UPPERCASE = /\p{Lu}/u;
const SYMBOL = /[^\p{L}\p{N}]/u;

/**
 * Every rule the policy declares, with whether `value` meets it.
 *
 * Rules the policy does not ask for are absent rather than shown as met — a
 * checklist should describe what is required here, not everything a password
 * could theoretically be.
 */
const passwordRequirements = (value: string, localization: Localization, policy: PasswordPolicy = {}): ReadonlyArray<PasswordRequirement> => {
    const minLength = policy.minLength ?? DEFAULT_PASSWORD_POLICY.minLength;
    const requirements: PasswordRequirement[] = [
        { label: localization.passwordRuleLength.replace("{min}", String(minLength)), met: value.length >= minLength },
    ];

    if (policy.requireLowercase === true) {
        requirements.push({ label: localization.passwordRuleLowercase, met: LOWERCASE.test(value) });
    }

    if (policy.requireUppercase === true) {
        requirements.push({ label: localization.passwordRuleUppercase, met: UPPERCASE.test(value) });
    }

    if (policy.requireDigit === true) {
        requirements.push({ label: localization.passwordRuleDigit, met: DIGIT.test(value) });
    }

    if (policy.requireSymbol === true) {
        requirements.push({ label: localization.passwordRuleSymbol, met: SYMBOL.test(value) });
    }

    return requirements;
};

/**
 * How far along the requirements a value is, 0–1, for a progress bar.
 *
 * Deliberately *not* an entropy estimate. A number derived from anything other
 * than the rules on screen can disagree with the checklist beside it — a bar
 * reading "weak" next to four green ticks is worse than no bar.
 */
const passwordScore = (requirements: ReadonlyArray<PasswordRequirement>): number => {
    if (requirements.length === 0) {
        return 0;
    }

    return requirements.filter((requirement) => requirement.met).length / requirements.length;
};

/**
 * Validate against the policy, returning the first unmet rule's message.
 *
 * The order matters: length before composition, because "must be 8 characters"
 * is the rule someone is most likely to be failing and the least annoying to be
 * told about first.
 */
const validatePassword = (value: string, localization: Localization, policy: PasswordPolicy = {}): string | undefined => {
    if (value.trim() === "") {
        return localization.passwordRequired;
    }

    const minLength = policy.minLength ?? DEFAULT_PASSWORD_POLICY.minLength;
    const maxLength = policy.maxLength ?? DEFAULT_PASSWORD_POLICY.maxLength;

    if (value.length < minLength) {
        return localization.passwordTooShort.replace("{min}", String(minLength));
    }

    if (value.length > maxLength) {
        return localization.passwordTooLong.replace("{max}", String(maxLength));
    }

    if (policy.requireLowercase === true && !LOWERCASE.test(value)) {
        return localization.passwordRuleLowercase;
    }

    if (policy.requireUppercase === true && !UPPERCASE.test(value)) {
        return localization.passwordRuleUppercase;
    }

    if (policy.requireDigit === true && !DIGIT.test(value)) {
        return localization.passwordRuleDigit;
    }

    if (policy.requireSymbol === true && !SYMBOL.test(value)) {
        return localization.passwordRuleSymbol;
    }

    return undefined;
};

export type { PasswordPolicy, PasswordRequirement };
export { DEFAULT_PASSWORD_POLICY, passwordRequirements, passwordScore, validatePassword };
