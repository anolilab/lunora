# spend-guard

Stops a Lunora Worker when a Cloudflare usage alert fires. Cloudflare usage alerts only notify; this item adds the pause.

## Install

```bash
lunora registry add spend-guard
```

This adds an R2 bucket binding `SPEND_GUARD` (`lunora-spend-guard`) to `wrangler.jsonc`, a `SPEND_GUARD_SECRET` placeholder to `.dev.vars`, and `lunora/spend-guard/index.ts`.

## Wire it up

1. Wrap the Worker's default export:

    ```ts
    import { withSpendGuard } from "../../lunora/spend-guard/index.js";

    export default withSpendGuard(createWorker({/* ... */}));
    ```

    For a hand-written `{ fetch, scheduled }` entry, wrap that object the same way.

2. Generate a secret and store it on the Worker:

    ```bash
    openssl rand -hex 32
    wrangler secret put SPEND_GUARD_SECRET
    ```

3. Create a webhook destination in the Cloudflare dashboard (Alerts > Destinations > Webhooks). Its URL is `https://<your-worker>/_lunora/spend-alert`, and its **Secret** is the value from step 2. Cloudflare sends that secret in the `cf-webhook-auth` header of every delivery.

4. Point the usage alerts at the destination:

    ```bash
    lunora cloudflare alerts setup --webhook <destination-id>
    ```

5. Run `lunora codegen` and deploy.

## What happens

- `POST /_lunora/spend-alert` with a matching `cf-webhook-auth` header and a body whose `alert_type` is `billing_usage_alert` writes the `spend-paused` object to the bucket.
- While that object exists, every request gets `503`, except the health probes (`/_lunora/health`, `/_lunora/health/ready`) and the internal dispatch paths (`/_lunora/scheduler/dispatch`, `/_lunora/queue`). Cron jobs (`scheduled`) do nothing. The `queue` and `email` entries of the Worker pass through untouched.
- Requests with a missing or wrong secret get `403`. With `SPEND_GUARD_SECRET` unset, every request gets `403`, so an unconfigured app cannot be paused from outside.
- A delivery that is authenticated but not a usage alert gets `202` and pauses nothing. Cloudflare's documented test message is `{"text": "..."}` with no `alert_type`, so the dashboard's Save and Test does not pause the app.

## Resume

Resuming is a deliberate step. Nothing clears the flag automatically:

```bash
wrangler r2 object delete lunora-spend-guard/spend-paused --remote
```

Check the spend first. Raise the budget or fix the cause, then resume. A pause that comes back on the next alert is the alert doing its job.

Each isolate caches its last read of the flag for 30 seconds, so a pause or a resume reaches every isolate within that window. The cache is what keeps the guard from costing an R2 read on every request.

## Verify before you rely on it

The `alert_type` check uses `billing_usage_alert`, the value Cloudflare's Terraform provider documents for usage-alert policies. Cloudflare's webhook payload reference lists `alert_type` as the same identifier namespace but does not show a usage-alert payload. Confirm it on a real alert: a non-matching delivery is logged as `spend-alert: ignored a delivery...` in `wrangler tail`. If you see that for a real usage alert, the pause will not fire, and the value needs correcting in `spend-guard.ts`.

## What the pause does not stop

- **Durable Object alarms and in-flight WebSocket sessions.** Shards keep running. A hibernated WebSocket attached to a Durable Object stays connected.
- **Scheduled jobs from `runAfter` / `runAt`.** They reach the Worker at `/_lunora/scheduler/dispatch`, which is not gated: a `503` there would make the scheduler retry the job for as long as the pause lasts.
- **Push-queue consumers.** They run through the Worker's `queue()` entry, which passes through, so they keep consuming while paused. The `/_lunora/queue` forwarding endpoint for Workers-for-Platforms is not gated either.
- **Traffic that reaches a Durable Object without passing through the Worker's `fetch`.** Gating happens in the Worker only.
- **Budget alerts.** Cloudflare exposes no API for account budget alerts. Set one in the dashboard; this item does not read it.
- **Products with no documented usage alert.** Image Transformations, for example, is not covered by a usage alert, so this item cannot pause on it. Its only guard is an account budget alert.

## Cost

The guard reads the bucket once per request, and once per cron firing. That is an R2 Class B operation each time. Add a short per-isolate cache if the read cost matters, but know that a cache delays the pause by its TTL.
