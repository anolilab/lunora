<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="dispatch" />

</a>

<h3 align="center">Shared dispatch runner for Lunora: call a Lunora function from a server-initiated context (workflow/queue/scheduled job) via /_lunora/scheduler/dispatch</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

# @lunora/dispatch

**Internal.** The shared dispatch runner Lunora's server-initiated execution
packages use to call back into Lunora functions. `createDispatchRunner({ env,
label })` returns a `ctx.run`-style function that POSTs to the worker's
`/_lunora/scheduler/dispatch` endpoint (admin-bearer authenticated) and resolves
the function's return value; `createDispatchLogger(prefix)` is the matching
console logger.

Consumed by `@lunora/workflow` and `@lunora/queue` (and available to any future
server-initiated dispatcher) so the dispatch contract lives in one place instead
of being copy-pasted per package. You depend on the workflow/queue packages, not
this directly.

## License

The lunora `@lunora/dispatch` package is open-sourced software licensed under
the [FSL-1.1-Apache-2.0 license](./LICENSE.md).
