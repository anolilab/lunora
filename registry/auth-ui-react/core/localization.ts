/**
 * Default user-facing strings for the auth UI, overridable per-app via
 * the provider's `localization` prop. Kept framework-agnostic (plain object) so
 * every port shares one string table. Field validation messages and flow copy
 * live here so a consumer can translate without editing component source.
 */
interface Localization {
    /** Navigation / link copy. */
    backToSignIn: string;
    /** Field labels. */
    codeLabel: string;
    confirmPasswordLabel: string;
    /** Field-validation messages. */
    emailInvalid: string;
    emailLabel: string;
    emailOtp: string;
    emailOtpSent: string;

    emailRequired: string;
    forgotPassword: string;
    forgotPasswordLink: string;
    forgotPasswordSent: string;
    /** Generic action / error copy. */
    genericError: string;

    haveAccount: string;
    magicLink: string;
    magicLinkSent: string;
    nameLabel: string;
    nameRequired: string;

    noAccount: string;

    otpRequired: string;
    passwordLabel: string;
    passwordMismatch: string;
    passwordRequired: string;
    passwordTooShort: string;
    resetPassword: string;
    resetPasswordDone: string;
    sendNewCode: string;
    /** Flow labels + success copy. */
    signIn: string;
    signInFailed: string;
    signUp: string;
    signUpFailed: string;
    twoFactor: string;
    twoFactorFailed: string;
}

const DEFAULT_LOCALIZATION: Localization = {
    backToSignIn: "Back to sign in",
    codeLabel: "Verification code",
    confirmPasswordLabel: "Confirm password",
    emailInvalid: "Enter a valid email address.",
    emailLabel: "Email",
    emailOtp: "Email me a code",
    emailOtpSent: "We emailed you a one-time code.",

    emailRequired: "Email is required.",
    forgotPassword: "Reset password",
    forgotPasswordLink: "Forgot your password?",
    forgotPasswordSent: "If that email exists, a reset link is on its way.",
    genericError: "Something went wrong. Please try again.",

    haveAccount: "Already have an account? Sign in",
    magicLink: "Email me a link",
    magicLinkSent: "Check your email for a sign-in link.",
    nameLabel: "Name",
    nameRequired: "Name is required.",

    noAccount: "Don't have an account? Sign up",

    otpRequired: "Enter the code we sent you.",
    passwordLabel: "Password",
    passwordMismatch: "Passwords do not match.",
    passwordRequired: "Password is required.",
    passwordTooShort: "Password must be at least 8 characters.",
    resetPassword: "Set new password",
    resetPasswordDone: "Your password has been updated. You can sign in now.",
    sendNewCode: "Use a different email",
    signIn: "Sign in",
    signInFailed: "Could not sign you in. Check your details and try again.",
    signUp: "Create account",
    signUpFailed: "Could not create your account. Try again.",
    twoFactor: "Verify",
    twoFactorFailed: "That code is not valid. Try again.",
};

/** Merge a caller's partial overrides over the defaults. */
const resolveLocalization = (overrides?: Partial<Localization>): Localization => {
    return {
        ...DEFAULT_LOCALIZATION,
        ...overrides,
    };
};

export type { Localization };
export { DEFAULT_LOCALIZATION, resolveLocalization };
