/**
 * Transactional email templates for the auth flows — the messages better-auth
 * sends: verify your address, reset your password, a magic link, a one-time
 * code, an organization invitation, and the security notices that follow a
 * change.
 *
 * # Why these live here and not beside the cards
 *
 * They are rendered by the **Worker**, not by the UI: `sendAuthEmail` in
 * `lunora/auth/index.ts` calls `renderEmail(&lt;VerifyEmail … />)` from
 * `@lunora/mail`. That makes them framework-agnostic in the way that matters —
 * a Vue or Svelte app sends exactly the same mail — even though they are written
 * in TSX, because `@react-email/render` is what turns them into HTML + text.
 *
 * They ship as the separate `auth-emails` registry item rather than inside
 * `auth-ui-&lt;framework>`, so a project only takes on `react` +
 * `@react-email/render` when it actually wants styled mail. Without the item,
 * the base `auth` item's plain-text bodies still work.
 *
 * # Styling
 *
 * Inline styles only, and a table-free single-column layout. Every serious mail
 * client strips `&lt;style>` blocks and most ignore flexbox and grid; `@media` is
 * unreliable. This is the subset that renders the same in Gmail, Outlook and
 * Apple Mail, so resist moving it to a stylesheet.
 */
import type { ReactElement } from "react";

/** The one place the palette lives, so all six templates stay a set. */
const COLORS = {
    background: "#f6f7f9",
    border: "#e5e7eb",
    muted: "#6b7280",
    surface: "#ffffff",
    text: "#111827",
} as const;

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

interface LayoutProps {
    children: ReactElement | ReactElement[];
    /** Shown small and grey under the main content. */
    footer?: string;
    heading: string;
    /** Your app's name, used in the masthead. */
    product?: string;
}

/**
 * The shared shell. `maxWidth` with `margin: auto` rather than a centering
 * table: the table trick exists for Outlook 2007-2013, which is below the floor
 * this package targets, and it makes every template three times longer.
 */
const Layout = ({ children, footer, heading, product = "Lunora" }: LayoutProps): ReactElement => (
    <html lang="en">
        <body style={{ backgroundColor: COLORS.background, fontFamily: FONT, margin: 0, padding: "32px 16px" }}>
            <div
                style={{
                    backgroundColor: COLORS.surface,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: "8px",
                    margin: "0 auto",
                    maxWidth: "480px",
                    padding: "32px",
                }}
            >
                <p style={{ color: COLORS.muted, fontSize: "13px", margin: "0 0 24px" }}>{product}</p>
                <h1 style={{ color: COLORS.text, fontSize: "20px", fontWeight: 600, margin: "0 0 16px" }}>{heading}</h1>
                {children}
                {footer === undefined ? null : <p style={{ color: COLORS.muted, fontSize: "12px", margin: "24px 0 0" }}>{footer}</p>}
            </div>
        </body>
    </html>
);

const Paragraph = ({ children }: { children: string }): ReactElement => (
    <p style={{ color: COLORS.text, fontSize: "14px", lineHeight: 1.6, margin: "0 0 16px" }}>{children}</p>
);

/**
 * The call-to-action.
 *
 * The raw URL is printed underneath on purpose: a link whose text is a verb is
 * unverifiable, and enough clients mangle or strip buttons that a user needs
 * something to copy. It is also the only way the plain-text rendering carries
 * the link at all.
 */
const ActionButton = ({ label, url }: { label: string; url: string }): ReactElement => (
    <>
        <a
            href={url}
            style={{
                backgroundColor: COLORS.text,
                borderRadius: "6px",
                color: COLORS.surface,
                display: "inline-block",
                fontSize: "14px",
                fontWeight: 500,
                padding: "10px 18px",
                textDecoration: "none",
            }}
        >
            {label}
        </a>
        <p style={{ color: COLORS.muted, fontSize: "12px", margin: "16px 0 0", wordBreak: "break-all" }}>{url}</p>
    </>
);

/** A one-time code, spaced so it is readable and selectable. */
const CodeBlock = ({ code }: { code: string }): ReactElement => (
    <p
        style={{
            backgroundColor: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: "6px",
            color: COLORS.text,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: "24px",
            letterSpacing: "0.2em",
            margin: "0 0 16px",
            padding: "16px",
            textAlign: "center",
        }}
    >
        {code}
    </p>
);

interface LinkEmailProps {
    product?: string;
    url: string;
}

/** Sent by `emailVerification.sendVerificationEmail`. */
const VerifyEmail = ({ product, url }: LinkEmailProps): ReactElement => (
    <Layout footer="If you didn't create this account, you can ignore this email." heading="Verify your email address" product={product}>
        <Paragraph>Confirm this address to finish setting up your account.</Paragraph>
        <ActionButton label="Verify email" url={url} />
    </Layout>
);

/** Sent by `emailAndPassword.sendResetPassword`. */
const ResetPasswordEmail = ({ product, url }: LinkEmailProps): ReactElement => (
    <Layout footer="If you didn't ask to reset your password, ignore this email — nothing has changed." heading="Reset your password" product={product}>
        <Paragraph>Choose a new password using the link below. It expires shortly.</Paragraph>
        <ActionButton label="Reset password" url={url} />
    </Layout>
);

/** Sent by the `magicLink` plugin. */
const MagicLinkEmail = ({ product, url }: LinkEmailProps): ReactElement => (
    <Layout footer="This link signs in whoever opens it, so don't forward it." heading="Your sign-in link" product={product}>
        <Paragraph>Use the link below to sign in. It works once and expires shortly.</Paragraph>
        <ActionButton label="Sign in" url={url} />
    </Layout>
);

interface OtpEmailProps {
    code: string;
    product?: string;
}

/** Sent by the `emailOTP` plugin, for sign-in, verification, and password reset. */
const OtpEmail = ({ code, product }: OtpEmailProps): ReactElement => (
    <Layout footer="If you didn't request this code, you can ignore this email." heading="Your one-time code" product={product}>
        <Paragraph>Enter this code to continue. It expires shortly.</Paragraph>
        <CodeBlock code={code} />
    </Layout>
);

interface InvitationEmailProps {
    inviterEmail?: string;
    organizationName: string;
    product?: string;
    url: string;
}

/** Sent when `organization.inviteMember` creates an invitation. */
const OrganizationInvitationEmail = ({ inviterEmail, organizationName, product, url }: InvitationEmailProps): ReactElement => (
    <Layout footer="If you weren't expecting this invitation, you can ignore this email." heading={`Join ${organizationName}`} product={product}>
        <Paragraph>
            {inviterEmail === undefined ? `You've been invited to join ${organizationName}.` : `${inviterEmail} invited you to join ${organizationName}.`}
        </Paragraph>
        <ActionButton label="Accept invitation" url={url} />
    </Layout>
);

interface NoticeEmailProps {
    /** What changed, e.g. "Your password was changed". */
    heading: string;
    message: string;
    product?: string;
    /** Where to go if it wasn't them. */
    url?: string;
}

/**
 * The after-the-fact security notices — password changed, email changed, a new
 * device signed in.
 *
 * One template rather than three, because the only thing that differs is the
 * sentence: they all say "this happened, and here is what to do if it wasn't
 * you". Splitting them would be three files that drift apart.
 */
const SecurityNoticeEmail = ({ heading, message, product, url }: NoticeEmailProps): ReactElement => (
    <Layout footer="If this wasn't you, change your password and review your active sessions." heading={heading} product={product}>
        <Paragraph>{message}</Paragraph>
        {url === undefined ? <></> : <ActionButton label="Review your account" url={url} />}
    </Layout>
);

export type { InvitationEmailProps, LinkEmailProps, NoticeEmailProps, OtpEmailProps };
export { MagicLinkEmail, OrganizationInvitationEmail, OtpEmail, ResetPasswordEmail, SecurityNoticeEmail, VerifyEmail };
