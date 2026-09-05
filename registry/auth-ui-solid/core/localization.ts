/**
 * Default user-facing strings for the auth UI, overridable per-app via the
 * provider's `localization` prop. Kept framework-agnostic (plain object) so every
 * port shares one string table. Field validation messages and flow copy live here
 * so a consumer can translate without editing component source.
 *
 * Keys are sorted alphabetically (lint enforces it), so they don't group by
 * flow — search for the string you want to change rather than scanning for a
 * section.
 */
interface Localization {
    accountsEmpty: string;
    accountsLastOne: string;
    accountsLink: string;
    accountsTitle: string;
    activeBadge: string;
    adminBan: string;
    adminImpersonate: string;
    adminSearch: string;
    adminStopImpersonating: string;
    adminTitle: string;
    adminUnban: string;
    adminUsersEmpty: string;
    anonymousSignIn: string;
    appearance: string;
    authorizedApps: string;
    authorizedAppsEmpty: string;
    avatar: string;
    avatarNoUploader: string;
    avatarRemove: string;
    avatarTooLarge: string;
    avatarUpload: string;
    avatarUploadFailed: string;
    avatarWrongType: string;
    backToSignIn: string;
    backupCodeLabel: string;
    backupCodes: string;
    backupCodeSignIn: string;
    backupCodesRegenerate: string;
    backupCodesRegenerated: string;
    cancel: string;
    changeEmail: string;
    changeEmailSent: string;
    changePassword: string;
    changePasswordDone: string;
    codeLabel: string;
    confirmPasswordLabel: string;
    consentAllow: string;
    consentDeny: string;
    consentExpired: string;
    consentMissing: string;
    consentTitle: string;
    consentWants: string;
    copied: string;
    copy: string;
    createOrganization: string;
    currentPasswordLabel: string;
    currentSession: string;
    deleteAccount: string;
    deleteAccountWarning: string;
    deviceApprove: string;
    deviceApproved: string;
    deviceCodeLabel: string;
    deviceCodeRequired: string;
    deviceDenied: string;
    deviceDeny: string;
    deviceFailed: string;
    deviceTitle: string;
    dismiss: string;
    emailInvalid: string;
    emailLabel: string;
    emailOtp: string;
    emailOtpSent: string;
    emailRequired: string;
    forgotPassword: string;
    forgotPasswordLink: string;
    forgotPasswordSent: string;
    genericError: string;
    haveAccount: string;
    invitationAccept: string;
    invitationMissing: string;
    invitationReject: string;
    invitations: string;
    invitationsEmpty: string;
    invitationTitle: string;
    inviteEmailLabel: string;
    inviteMember: string;
    lastUsed: string;
    leaveOrganization: string;
    loading: string;
    magicLink: string;
    magicLinkSent: string;
    members: string;
    multiSessionEmpty: string;
    multiSessionTitle: string;
    nameLabel: string;
    nameRequired: string;
    newEmailLabel: string;
    newPasswordLabel: string;
    noAccount: string;
    noOrganizations: string;
    organizationCreateDisallowed: string;
    organizationLimitReached: string;
    organizationLogo: string;
    organizationName: string;
    organizationNameRequired: string;
    organizations: string;
    organizationSaved: string;
    organizationSettings: string;
    organizationSlug: string;
    organizationSlugRequired: string;
    otpRequired: string;
    passkeyAdd: string;
    passkeyName: string;
    passkeyRename: string;
    passkeys: string;
    passkeysEmpty: string;
    passkeyUnnamed: string;
    passwordLabel: string;
    passwordMismatch: string;
    passwordRequired: string;
    passwordRuleDigit: string;
    passwordRuleLength: string;
    passwordRuleLowercase: string;
    passwordRuleSymbol: string;
    passwordRuleUppercase: string;
    passwordTooLong: string;
    passwordTooShort: string;
    phoneLabel: string;
    phoneOtpSent: string;
    phoneRequired: string;
    phoneVerified: string;
    phoneVerify: string;
    profile: string;
    profileSaved: string;
    remove: string;
    resetPassword: string;
    resetPasswordOtpDescription: string;
    revoke: string;
    revokeAccess: string;
    revokeOthers: string;
    roleLabel: string;
    saveChanges: string;
    sendNewCode: string;
    sessionNotFresh: string;
    sessions: string;
    sessionsEmpty: string;
    signIn: string;
    signInFailed: string;
    signInWith: string;
    signOut: string;
    signUp: string;
    signUpFailed: string;
    switchAccount: string;
    switchOrganization: string;
    teamNameLabel: string;
    teams: string;
    teamsEmpty: string;
    themeDark: string;
    themeLight: string;
    themeSystem: string;
    twoFactor: string;
    twoFactorDisable: string;
    twoFactorEnable: string;
    twoFactorEnabled: string;
    twoFactorFailed: string;
    twoFactorNeedsPassword: string;
    twoFactorScan: string;
    twoFactorSecret: string;
    twoFactorSetup: string;
    twoFactorUseAuthenticator: string;
    /** Fallback when a session has neither a user-agent nor an IP. */
    unknownDevice: string;
    usernameAvailable: string;
    usernameChecking: string;
    usernameLabel: string;
    usernameRequired: string;
    usernameSaved: string;
    usernameTaken: string;
    verifyEmail: string;
    verifyEmailFailed: string;
    verifyEmailNoToken: string;
    verifyEmailResend: string;
    /** The failed-verification button, which retries the same token — not a new link. */
    verifyEmailRetry: string;
    verifyEmailSent: string;
    verifyEmailVerifying: string;
}

const DEFAULT_LOCALIZATION: Localization = {
    accountsEmpty: "No accounts linked yet.",
    accountsLastOne: "You can't unlink your only sign-in method.",
    accountsLink: "Link account",
    accountsTitle: "Linked accounts",
    activeBadge: "Active",
    adminBan: "Ban",
    adminImpersonate: "Impersonate",
    adminSearch: "Search users by email",
    adminStopImpersonating: "Stop impersonating",
    adminTitle: "Users",
    adminUnban: "Unban",
    adminUsersEmpty: "No users match that search.",
    anonymousSignIn: "Continue as guest",
    appearance: "Appearance",
    authorizedApps: "Authorized applications",
    authorizedAppsEmpty: "You haven't authorized any applications.",
    avatar: "Avatar",
    avatarNoUploader: "Avatar uploads are not configured for this app.",
    avatarRemove: "Remove photo",
    avatarTooLarge: "That image is too large.",
    avatarUpload: "Upload photo",
    avatarUploadFailed: "Could not upload that image. Try again.",
    avatarWrongType: "Choose a PNG, JPEG, WebP, GIF, or AVIF image.",
    backToSignIn: "Back to sign in",
    backupCodeLabel: "Backup code",
    backupCodes: "Save these backup codes somewhere safe:",
    backupCodeSignIn: "Use a backup code",
    backupCodesRegenerate: "Regenerate backup codes",
    backupCodesRegenerated: "New backup codes generated. The old ones no longer work.",
    cancel: "Cancel",
    changeEmail: "Change email",
    changeEmailSent: "Check your new inbox to confirm the change.",
    changePassword: "Change password",
    changePasswordDone: "Your password has been changed.",
    codeLabel: "Verification code",
    confirmPasswordLabel: "Confirm password",
    consentAllow: "Allow",
    consentDeny: "Deny",
    consentExpired: "This request is no longer valid. Start again from the application.",
    consentMissing: "There's no authorization request to review.",
    consentTitle: "Authorize application",
    consentWants: "wants access to:",
    copied: "Copied",
    copy: "Copy",
    createOrganization: "Create organization",
    currentPasswordLabel: "Current password",
    currentSession: "This device",
    deleteAccount: "Delete account",
    deleteAccountWarning: "This permanently deletes your account and cannot be undone.",
    deviceApprove: "Approve",
    deviceApproved: "Device approved. You can close this page.",
    deviceCodeLabel: "Device code",
    deviceCodeRequired: "Enter the code shown on your device.",
    deviceDenied: "Device denied.",
    deviceDeny: "Deny",
    deviceFailed: "That code is not valid or has expired.",
    deviceTitle: "Authorize device",
    dismiss: "Dismiss",
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
    invitationAccept: "Accept invitation",
    invitationMissing: "That invitation link is not valid or has expired.",
    invitationReject: "Decline",
    invitations: "Pending invitations",
    invitationsEmpty: "No invitations waiting for you.",
    invitationTitle: "You've been invited",
    inviteEmailLabel: "Email to invite",
    inviteMember: "Invite member",
    lastUsed: "Last used",
    leaveOrganization: "Leave organization",
    loading: "Loading…",
    magicLink: "Email me a link",
    magicLinkSent: "Check your email for a sign-in link.",
    members: "Members",
    multiSessionEmpty: "No other accounts signed in on this device.",
    multiSessionTitle: "Switch account",
    nameLabel: "Name",
    nameRequired: "Name is required.",
    newEmailLabel: "New email",
    newPasswordLabel: "New password",
    noAccount: "Don't have an account? Sign up",
    noOrganizations: "You're not in any organization yet.",
    organizationCreateDisallowed: "Your account can't create organizations.",
    organizationLimitReached: "You've reached the maximum number of organizations.",
    organizationLogo: "Logo URL",
    organizationName: "Organization name",
    organizationNameRequired: "Organization name is required.",
    organizations: "Organizations",
    organizationSaved: "Organization settings saved.",
    organizationSettings: "Organization settings",
    organizationSlug: "Slug",
    organizationSlugRequired: "Slug is required.",
    otpRequired: "Enter the code we sent you.",
    passkeyAdd: "Add a passkey",
    passkeyName: "Passkey name",
    passkeyRename: "Rename",
    passkeys: "Passkeys",
    passkeysEmpty: "No passkeys registered yet.",
    passkeyUnnamed: "Unnamed passkey",
    passwordLabel: "Password",
    passwordMismatch: "Passwords do not match.",
    passwordRequired: "Password is required.",
    passwordRuleDigit: "At least one number",
    passwordRuleLength: "At least {min} characters",
    passwordRuleLowercase: "At least one lowercase letter",
    passwordRuleSymbol: "At least one symbol",
    passwordRuleUppercase: "At least one uppercase letter",
    passwordTooLong: "Password must be at most {max} characters.",
    passwordTooShort: "Password must be at least {min} characters.",
    phoneLabel: "Phone number",
    phoneOtpSent: "We texted you a code.",
    phoneRequired: "Phone number is required.",
    phoneVerified: "Phone number verified.",
    phoneVerify: "Verify phone number",
    profile: "Profile",
    profileSaved: "Your profile has been updated.",
    remove: "Remove",
    resetPassword: "Set new password",
    resetPasswordOtpDescription: "Enter the code we emailed you, then choose a new password.",
    revoke: "Revoke",
    revokeAccess: "Revoke access",
    revokeOthers: "Sign out other sessions",
    roleLabel: "Role",
    saveChanges: "Save changes",
    sendNewCode: "Use a different email",
    sessionNotFresh: "For your security, sign in again before making this change.",
    sessions: "Active sessions",
    sessionsEmpty: "No other active sessions.",
    signIn: "Sign in",
    signInFailed: "Could not sign you in. Check your details and try again.",
    signInWith: "Continue with",
    signOut: "Sign out",
    signUp: "Create account",
    signUpFailed: "Could not create your account. Try again.",
    switchAccount: "Switch to this account",
    switchOrganization: "Switch",
    teamNameLabel: "Team name",
    teams: "Teams",
    teamsEmpty: "No teams yet.",
    themeDark: "Dark",
    themeLight: "Light",
    themeSystem: "System",
    twoFactor: "Verify",
    twoFactorDisable: "Disable 2FA",
    twoFactorEnable: "Enable 2FA",
    twoFactorEnabled: "Two-factor authentication is on.",
    twoFactorFailed: "That code is not valid. Try again.",
    twoFactorNeedsPassword: "Set a password before turning on two-factor authentication.",
    twoFactorScan: "Add this account to your authenticator app using the setup key below, then enter the 6-digit code it generates.",
    twoFactorSecret: "Setup key:",
    twoFactorSetup: "Two-factor authentication",
    twoFactorUseAuthenticator: "Use your authenticator app instead",
    unknownDevice: "Unknown device",
    usernameAvailable: "That username is available.",
    usernameChecking: "Checking…",
    usernameLabel: "Username",
    usernameRequired: "Username is required.",
    usernameSaved: "Your username has been updated.",
    usernameTaken: "That username is taken.",
    verifyEmail: "Verify your email",
    verifyEmailFailed: "We couldn't verify that link. Try again.",
    verifyEmailNoToken: "This page needs a verification link to work.",
    verifyEmailResend: "Send a new link",
    verifyEmailRetry: "Try again",
    verifyEmailSent: "Check your email for a verification link.",
    verifyEmailVerifying: "Verifying your email…",
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
