# @cirrus/testing

The user-facing toolkit for end-to-end testing a Cirrus app.

It bundles the test helpers you reach for when driving real flows against a
running `cirrus dev` — starting with the **dev mail catcher**, so a Playwright
(or any HTTP) test can assert on the email your app sends without wiring up a
real provider.

## Mail catcher helpers

In `cirrus dev`, `@cirrus/mail` captures every outbound email — sign-up
verification, forgot-password, magic links, and anything `@cirrus/auth` sends —
into the studio's root-shard inbox instead of delivering it. These helpers read
that inbox over the admin RPC, so a test can drive the whole loop
deterministically.

```ts
import { extractLink, waitForMail } from "@cirrus/testing";

// Trigger the flow (e.g. POST /api/auth/forgot-password), then:
const mail = await waitForMail({
    adminToken: process.env.CIRRUS_ADMIN_TOKEN!,
    baseUrl: "http://localhost:8787",
    to: "alice@example.test",
    subjectMatch: "Reset your password",
});

const resetLink = extractLink(mail, { match: "/reset-password" });
// → visit `resetLink`, set a new password, assert success.
```

| Export             | Purpose                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `waitForMail`      | Poll the captured-mail inbox until a message to `to` (optionally matching a subject) appears, then return it. Throws on timeout. |
| `listCapturedMail` | Read the captured-mail inbox newest-first.                                                                                       |
| `extractLink`      | Pull the first link out of a captured message (html first, then text), optionally filtered by a substring.                       |

All three are re-exported from `@cirrus/mail/testing`.

## Roadmap

This package is the home for E2E fixtures to grow into — auth fixtures
(programmatic sign-in / session seeding) and friends — so your tests import one
package rather than reaching into each sub-package's `/testing` entry.
