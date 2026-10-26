# @lunora/jwt-auth

Bring your own auth to Lunora. Verifies a JWT from an external identity
provider against the provider's JWKS and maps it onto Lunora's identity. The
result feeds `ctx.auth`, RLS, `serverDefault` columns and live subscriptions
through the runtime's `resolveIdentity` hook.

Presets cover Clerk, WorkOS AuthKit, Auth0 and Supabase Auth. `jwtIdentityResolver`
handles any other OIDC/JWT issuer.

```sh
pnpm add @lunora/jwt-auth
```

```ts
import { clerk } from "@lunora/jwt-auth";
import { createWorker } from "@lunora/runtime";

createWorker({
    resolveIdentity: clerk({ publishableKey: env.CLERK_PUBLISHABLE_KEY, authorizedParties: ["https://app.example.com"] }),
    shardDO: env.SHARD,
});
```

```ts
import { jwtIdentityResolver } from "@lunora/jwt-auth";

// Any OIDC issuer: the JWKS is discovered from <issuer>/.well-known/openid-configuration.
const resolveIdentity = jwtIdentityResolver({ issuer: "https://auth.example.com/", audience: "https://api.example.com" });
```

See the [package docs](./docs/index.mdx) and the
[external auth guide](https://lunora.sh/docs/concepts/external-auth) for client
token wiring, WebSockets and RLS.

## License

FSL-1.1-Apache-2.0
