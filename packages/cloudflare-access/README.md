# @lunora/cloudflare-access

Cloudflare Access (Cloudflare One / Zero Trust) identity for Lunora.

Verifies the `Cf-Access-Jwt-Assertion` JWT against your team's JWKS and maps the
verified claims onto Lunora's identity — feeding `ctx.auth`, RLS, `serverDefault`
columns, and live subscriptions via the runtime's `resolveIdentity` hook.

```sh
pnpm add @lunora/cloudflare-access
```

```ts
import { createAccessResolver } from "@lunora/cloudflare-access";

options.resolveIdentity = createAccessResolver({
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN, // "acme" | "acme.cloudflareaccess.com"
    aud: env.CF_ACCESS_AUD, // the Access application's AUD tag
});
```

See the [package docs](./docs/index.mdx) for composing with `@lunora/auth`,
reading claims in RLS policies, and the full API.

## License

FSL-1.1-Apache-2.0
