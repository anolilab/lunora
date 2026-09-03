# auth-emails

Styled transactional email templates for the Lunora auth flows — the messages
better-auth actually sends. Copy-in and yours to edit, like every registry item.

They are rendered by the **Worker**, not by any view layer, so the same mail goes
out whether your frontend is React, Vue, Svelte, Solid or Angular. TSX is only
the authoring format: `@react-email/render` turns each one into the HTML + text
pair `@lunora/mail` sends.

```bash
lunora registry add auth-emails
```

This:

1. Adds `@lunora/mail`, `@react-email/render` and `react` to your
   `package.json` (run `pnpm install` afterwards).
2. Copies `lunora/auth/emails.tsx` into your project — this is **yours** to
   edit.

It `requires` the base `auth` item, so `lunora registry add auth-emails` pulls
that in too if you have not added it yet. Without this item the base `auth`
item's plain-text bodies keep working; this is the opt-in that trades a `react`
dependency for styled mail.

## What ships

| Export                        | Props                                               | Sent when                                       |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `VerifyEmail`                 | `{ url, product? }`                                 | a new sign-up needs its address verified        |
| `ResetPasswordEmail`          | `{ url, product? }`                                 | someone asked to reset their password           |
| `MagicLinkEmail`              | `{ url, product? }`                                 | the `auth-magic-link` item sends a sign-in link |
| `OtpEmail`                    | `{ code, product? }`                                | the `auth-otp` item sends a one-time code       |
| `OrganizationInvitationEmail` | `{ url, organizationName, inviterEmail, product? }` | a member is invited to an organization          |
| `SecurityNoticeEmail`         | `{ heading, message, url?, product? }`              | after a password / email / 2FA change           |

Every template takes an optional `product` prop for the masthead (default
`"Lunora"`).

## Use one

Import the template in `lunora/auth/index.ts` and render it with `@lunora/mail`'s
`renderEmail`, replacing the plain-text body the base `auth` item scaffolds:

```tsx
import { renderEmail } from "@lunora/mail";

import { ResetPasswordEmail } from "./emails";

sendResetPassword: async ({ url, user }) => {
    const { html, text } = await renderEmail(<ResetPasswordEmail url={url} />);

    await sendAuthEmail(env, { html, subject: "Reset your password", text, to: user.email });
},
```

`renderEmail` returns both halves, and `sendAuthEmail` passes both through to
`@lunora/mail` — so the message degrades to the plain-text body in a client that
refuses HTML.

Because the file is `.tsx`, the module that imports it has to be `.tsx` too (or
call `renderEmail(createElement(ResetPasswordEmail, { url }))` from a `.ts`
file), and your `tsconfig.json` needs `"jsx": "react-jsx"`.

## Styling

Inline styles only, and a table-free single-column layout — no `<style>` block,
no flexbox, no grid, no `@media`. That is the subset that renders the same in
Gmail, Outlook and Apple Mail; every serious client strips or ignores the rest.
Restyle freely, but keep the styles inline.

The palette lives in one `COLORS` object at the top of the file, so the six
templates stay a set when you change it.

## What you own

Everything in `lunora/auth/emails.tsx` is copied into your repo — change the
copy, the palette, the masthead, or add a seventh template alongside the six.
`@lunora/mail` provides the renderer and the transport; this item is just the
templates.
