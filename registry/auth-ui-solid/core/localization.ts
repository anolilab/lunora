/**
 * Default user-facing strings for the auth UI, overridable per-app via
 * the provider's `localization` prop. Kept framework-agnostic (plain object) so
 * every port shares one string table. Field validation messages and flow copy
 * live here so a consumer can translate without editing component source.
 */
interface Localization {
    /** Organizations. */
    activeBadge: string;
    /** Navigation / link copy. */
    backToSignIn: string;
    /** Two-factor setup. */
    backupCodes: string;
    cancel: string;
    /** Account & security settings. */
    changeEmail: string;
    changeEmailSent: string;
    changePassword: string;

    changePasswordDone: string;
    /** Field labels. */
    codeLabel: string;
    confirmPasswordLabel: string;
    createOrganization: string;
    currentPasswordLabel: string;

    currentSession: string;
    deleteAccount: string;
    deleteAccountWarning: string;
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
    invitations: string;
    inviteEmailLabel: string;
    inviteMember: string;
    magicLink: string;
    magicLinkSent: string;
    members: string;
    nameLabel: string;

    nameRequired: string;
    newEmailLabel: string;
    newPasswordLabel: string;
    noAccount: string;
    noOrganizations: string;
    organizationName: string;
    organizations: string;
    organizationSlug: string;
    otpRequired: string;
    passwordLabel: string;
    passwordMismatch: string;
    passwordRequired: string;
    passwordTooShort: string;
    profile: string;
    profileSaved: string;
    remove: string;
    resetPassword: string;
    resetPasswordDone: string;

    revoke: string;
    revokeOthers: string;
    roleLabel: string;
    saveChanges: string;
    sendNewCode: string;
    sessions: string;
    sessionsEmpty: string;
    /** Flow labels + success copy. */
    signIn: string;
    signInFailed: string;
    signOut: string;
    signUp: string;
    signUpFailed: string;
    switchOrganization: string;
    twoFactor: string;

    twoFactorDisable: string;
    twoFactorEnable: string;
    twoFactorEnabled: string;
    twoFactorFailed: string;
    twoFactorScan: string;
    twoFactorSetup: string;
}

const DEFAULT_LOCALIZATION: Localization = {
    activeBadge: "Active",
    backToSignIn: "Back to sign in",
    backupCodes: "Save these backup codes somewhere safe:",
    cancel: "Cancel",
    changeEmail: "Change email",
    changeEmailSent: "Check your new inbox to confirm the change.",
    changePassword: "Change password",

    changePasswordDone: "Your password has been changed.",
    codeLabel: "Verification code",
    confirmPasswordLabel: "Confirm password",
    createOrganization: "Create organization",
    currentPasswordLabel: "Current password",

    currentSession: "This device",
    deleteAccount: "Delete account",
    deleteAccountWarning: "This permanently deletes your account and cannot be undone.",
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
    invitations: "Pending invitations",
    inviteEmailLabel: "Email to invite",
    inviteMember: "Invite member",
    magicLink: "Email me a link",
    magicLinkSent: "Check your email for a sign-in link.",
    members: "Members",
    nameLabel: "Name",

    nameRequired: "Name is required.",
    newEmailLabel: "New email",
    newPasswordLabel: "New password",
    noAccount: "Don't have an account? Sign up",
    noOrganizations: "You're not in any organization yet.",
    organizationName: "Organization name",
    organizations: "Organizations",
    organizationSlug: "Slug",
    otpRequired: "Enter the code we sent you.",
    passwordLabel: "Password",
    passwordMismatch: "Passwords do not match.",
    passwordRequired: "Password is required.",
    passwordTooShort: "Password must be at least 8 characters.",
    profile: "Profile",
    profileSaved: "Your profile has been updated.",
    remove: "Remove",
    resetPassword: "Set new password",
    resetPasswordDone: "Your password has been updated. You can sign in now.",

    revoke: "Revoke",
    revokeOthers: "Sign out other sessions",
    roleLabel: "Role",
    saveChanges: "Save changes",
    sendNewCode: "Use a different email",
    sessions: "Active sessions",
    sessionsEmpty: "No other active sessions.",
    signIn: "Sign in",
    signInFailed: "Could not sign you in. Check your details and try again.",
    signOut: "Sign out",
    signUp: "Create account",
    signUpFailed: "Could not create your account. Try again.",
    switchOrganization: "Switch",
    twoFactor: "Verify",

    twoFactorDisable: "Disable 2FA",
    twoFactorEnable: "Enable 2FA",
    twoFactorEnabled: "Two-factor authentication is on.",
    twoFactorFailed: "That code is not valid. Try again.",
    twoFactorScan: "Scan this with your authenticator app, then enter the 6-digit code.",
    twoFactorSetup: "Two-factor authentication",
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
