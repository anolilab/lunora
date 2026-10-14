# @lunora/privacy

Data-subject rights for Lunora apps: the GDPR Art. 15 and 20 export, Art. 17
erasure, and retention holds for records the law says to keep.

> **Not reviewed by a lawyer.** The legal and tax values in this package are research, not
> legal advice, and no lawyer or tax adviser has checked them. The sources and open
> questions are in `docs/legal.mdx`. Do not rely on a default until a qualified
> lawyer and a tax adviser have reviewed it against your own processing.
>
> **Experimental.** The package is published as an alpha (`1.0.0-alpha.*`), and its API may still change.

## What is built

- `retain`: a retention hold on a table's rows, naming a rule from a preset.
- `definePrivacy`: the bound API, `privacyFor(ctx, identity?)`. Its `tick` reports requests near or past the Art. 12(3)
  deadline, counted in calendar months under Reg. 1182/71 Art. 3(2)(c). Its `coverage` flags a table
  that no dataset covers and that no exclusion explains. Its export decides, per
  dataset, whether the archive lists Art. 15 only or Art. 15 and 20.
- `@lunora/privacy/workflow`: the port RPC a durable workflow needs (`dispatchPort`,
  `remotePorts`, the wire codec), derived from one method table.
- `@lunora/privacy/eu`: the EU response time and erasure grace.
- `@lunora/privacy/de`: the HGB §257 and AO §147 retention periods.

## Status

- Built and tested: the deadline and lifecycle rules, the request service, datasets,
  the export archive, erasure, the deadline sweep, the signed download, restore
  tombstones, the retention archive purge and the operator surface.
- The Studio has a Privacy requests tab. It appears only when the app declares
  `@lunora/privacy`.
- Not finished: there is no end-to-end demo (`examples/privacy` has no sign-in, declares no
  `authDataset` and does not use `retain()`; there is no payments dataset, only `retain()` with
  the `de.voucher` rule bound to the app's own tables), the workerd suite for the storage paths
  is not written, and registering the workflow handlers from the per-call factory has not been
  checked against codegen (plan §4.2).
- Not reviewed: every legal and tax value. See `docs/legal.mdx`.
