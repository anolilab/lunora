# Auth UI — React

Copy-in, user-owned React auth screens for Lunora, on top of the base `auth`
item and `@lunora/react`. Inspired by better-auth-ui, distributed the shadcn way:
the code lands in your project and you own it.

```bash
lunora add auth-ui        # auto-detects React and pulls in the base `auth` item
```

## What lands in your project

```
lunora/auth-ui/
  core/         framework-agnostic flow controllers (shared across frameworks)
  react/        the React views (cards) + <AuthUIProvider> + useController
  client.ts     your better-auth client — edit this to toggle plugins
  styles.css    minimal, token-aligned CSS (no Tailwind)
```

## Wire it up

```tsx
import { AuthUIProvider, SignInCard } from "./lunora/auth-ui/react";
import { authClient } from "./lunora/auth-ui/client";
import "./lunora/auth-ui/styles.css";

// Pass your router in so navigation is client-side (react-router shown):
function AuthRoot() {
    const navigate = useNavigate();

    return (
        <AuthUIProvider
            authClient={authClient}
            nav={{ navigate: (to) => navigate(to), replace: (to) => navigate(to, { replace: true }) }}
            redirects={{ afterSignIn: "/app" }}
            social={["github"]}
        >
            <SignInCard />
        </AuthUIProvider>
    );
}
```

Auth cards: `SignInCard`, `SignUpCard`, `ForgotPasswordCard`,
`ResetPasswordCard`, `MagicLinkCard`, `EmailOtpCard`, `TwoFactorCard`.

Account & security: `ProfileCard`, `ChangeEmailCard`, `ChangePasswordCard`,
`SessionsCard`, `TwoFactorSetupCard`, `DeleteAccountCard`, `SignOutButton`.

Organizations: `OrganizationsCard`, `MembersCard`.

Enable magic-link / email-OTP / 2FA by adding the matching server item
(`lunora add auth-magic-link`, `auth-otp`) and flipping the toggle in
`client.ts`.

## Customizing

Everything is yours. Restyle `styles.css` (it reads the Lunora design tokens),
translate via the provider's `localization` prop, or edit the cards directly.
Re-running `lunora add auth-ui` 3-way merges upstream changes and writes a
`.new` file next to anything you've edited that also changed upstream.
