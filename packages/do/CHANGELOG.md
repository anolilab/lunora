## @lunora/do [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/do@1.0.0-alpha.4...@lunora/do@1.0.0-alpha.5) (2026-06-27)

### Features

* extending db  ([#32](https://github.com/anolilab/lunora/issues/32)) ([6b77a16](https://github.com/anolilab/lunora/commit/6b77a16996e6aa59c19c801c3ea18004deccd6dc))

### Miscellaneous Chores

* update our og pacakge image ([63e6811](https://github.com/anolilab/lunora/commit/63e6811e2dfb94bc2cc38c05292b527e884660b5))

### Tests

* **do:** split write-throughput + relation-predicates benches for CodSpeed ([#28](https://github.com/anolilab/lunora/issues/28)) ([b14031e](https://github.com/anolilab/lunora/commit/b14031e34ca0b17193eeba7061cce34841fd514b))

## @lunora/do [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/do@1.0.0-alpha.3...@lunora/do@1.0.0-alpha.4) (2026-06-24)

### Features

* **r2sql:** typed R2 SQL client with window functions, DISTINCT and set ops ([#26](https://github.com/anolilab/lunora/issues/26)) ([fe9546b](https://github.com/anolilab/lunora/commit/fe9546bb3473875d47939bf93e6fbb81084a07aa))

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))

### Code Refactoring

* remove dead code flagged by fallow ([be57eca](https://github.com/anolilab/lunora/commit/be57ecaf4d6f3bc95d7b1a5876305dfb2af80e45))

### Tests

* **bench:** fix codspeed bench failures (hook timeout + seeding) ([f2af120](https://github.com/anolilab/lunora/commit/f2af12081c33296a66daa314f3d90fd4144904fe))

## @lunora/do [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/do@1.0.0-alpha.2...@lunora/do@1.0.0-alpha.3) (2026-06-22)

### Bug Fixes

* **bench:** seed remaining CodSpeed benches in beforeAll ([0fde66b](https://github.com/anolilab/lunora/commit/0fde66b509a99d09d90c6141e01c12c55ac8f5de))

## @lunora/do [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/do@1.0.0-alpha.1...@lunora/do@1.0.0-alpha.2) (2026-06-22)

### Bug Fixes

* **bench:** seed CodSpeed benches in beforeAll, not top-level await ([3964f8a](https://github.com/anolilab/lunora/commit/3964f8aa241e4fac0a24236d693647144f0ea825))

## @lunora/do 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Styles

* format source with prettier and ignore generated artifacts ([c63b52a](https://github.com/anolilab/lunora/commit/c63b52a05578b8476cf627babe246acd9730c0f9))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))

### Continuous Integration

* rebuild test + lint pipelines on the visulima model (vis, no build job) ([#25](https://github.com/anolilab/lunora/issues/25)) ([63f7f88](https://github.com/anolilab/lunora/commit/63f7f88c0451f9ba1599780176b806a469f01ca6))


### Dependencies

* **@lunora/vectors:** upgraded to 1.0.0-alpha.1
