# @lunora/privacy

Data-subject rights for Lunora apps: the GDPR Art. 15 and 20 export, Art. 17
erasure, and retention holds for records the law says to keep.

> **Experimental.** The package is under development and is not released. Every
> legal and tax value it ships is pending review by counsel or a tax adviser, and
> the test `presets.test.ts` lists each one that is still open.

## What is built

- `addCalendarMonths`, `dueAt`, `extendedDueAt`: the Art. 12(3) deadline, counted
  in calendar months under Reg. 1182/71 Art. 3(2)(c).
- `retain`, `retainUntil`: a named retention period, from the end of the calendar
  year or from a date.
- `checkCoverage`: flags a table that no dataset covers and that no exclusion
  explains.
- `articlesFor`: decides whether a dataset's export falls under Art. 15 only, or
  under Art. 15 and 20.
- `@lunora/privacy/eu`: the EU response time and erasure grace.
- `@lunora/privacy/de`: the HGB §257 and AO §147 retention periods.

## What is not built yet

The export and erasure workflows, the request tables, and the app integration
are still to come. Until they land, this package is the pure core only.
