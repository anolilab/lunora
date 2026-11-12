# Plan 606 — `lunora cloudflare alerts` lists notification policies without paging

**Baseline:** `4121b67cc` (2026-11-12)
**Status:** REJECTED (Cloudflare's policy list endpoint is not paginated, so one GET returns every policy)

## 0. Headline finding

The audit lead said `lunora cloudflare alerts setup` reads only the first page of
notification policies. On an account with more policies than one page, it would
miss an existing `Lunora usage: …` policy and create a duplicate. Cloudflare
documents this endpoint as **unpaginated**, so the lead does not hold.

## 1. Current state (audit)

- `packages/cli/src/commands/cloudflare/alerts/handler.ts:71-75` — `listPolicies`
  makes a single `client.notifications("…", "GET", "/alerting/v3/policies")` call.
- `packages/cli/src/commands/cloudflare/alerts/api.ts:239-250` —
  `notificationsList` appends `page=N` and follows `result_info.total_pages`. Only
  `deliveries.ts:71` uses it, for `/alerting/v3/history`.

## 2. Evidence that the endpoint returns everything

- Cloudflare API reference, "List Notification policies":
  <https://developers.cloudflare.com/api/resources/alerting/subresources/policies/methods/list/>.
  The only parameter is the `account_id` path parameter. There are no query
  parameters, and the response has `errors`, `messages`, `success` and `result[]`
  with no `result_info`.
- `cloudflare/api-schemas` `openapi.json`, operation
  `notification-policies-list-notification-policies`
  (`GET /accounts/{account_id}/alerting/v3/policies`):
    - Its only parameter is `account_id`.
    - Its 200 schema is `aaa_policies_components-schemas-response_collection`, which
      is `api-response-common-2` plus `result: Policy[]` with no `result_info`.
    - Compare the history list on the same API (`/alerting/v3/history`). It declares
      `page` and `per_page` query parameters, which is why the existing helper is
      used there.
- The official Go SDK (`cloudflare/cloudflare-go`, `alerting/policy.go`) types
  `PolicyService.List` as `pagination.SinglePage[Policy]`, its non-paginated list
  type.

## 3. Verdict

Not a defect. Paging `/alerting/v3/policies` through `notificationsList` would
send a `page=` parameter the endpoint does not declare, to solve a problem the
documentation says does not exist.

## 4. Not verified

This was not checked against a real Cloudflare account with a large number of
notification policies. If someone observes a truncated `result` (for example a
`result_info.total_pages > 1` in a live response), reopen this plan with that
response as evidence.
