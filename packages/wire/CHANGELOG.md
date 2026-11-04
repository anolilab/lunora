## @lunora/wire [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/wire@1.0.0-alpha.5...@lunora/wire@1.0.0-alpha.6) (2026-10-30)

### Bug Fixes

* **wire:** classify each value with one prototype read ([#1427](https://github.com/anolilab/lunora/issues/1427)) ([ab466ed](https://github.com/anolilab/lunora/commit/ab466ed7e62f5ff6e2d6aca7d27dbb9bdade3f08))

## @lunora/wire [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/wire@1.0.0-alpha.4...@lunora/wire@1.0.0-alpha.5) (2026-10-30)

### Performance Improvements

* **wire:** skip decodeWire on tagless json text ([#1384](https://github.com/anolilab/lunora/issues/1384)) ([ec9dd3d](https://github.com/anolilab/lunora/commit/ec9dd3de697df597b24cbea981ea25a1a2c8fcea))

## @lunora/wire [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/wire@1.0.0-alpha.3...@lunora/wire@1.0.0-alpha.4) (2026-10-30)

### Performance Improvements

* **wire:** cheaper encode, decode and stable keys ([#1375](https://github.com/anolilab/lunora/issues/1375)) ([a62a3bf](https://github.com/anolilab/lunora/commit/a62a3bfcf3115b1a61db47a4121f493c1192e5e7))

## @lunora/wire [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/wire@1.0.0-alpha.2...@lunora/wire@1.0.0-alpha.3) (2026-10-27)

### Performance Improvements

* cut per-request CPU on the DO dispatch and fan-out path ([#1351](https://github.com/anolilab/lunora/issues/1351)) ([2f94aa9](https://github.com/anolilab/lunora/commit/2f94aa9bafb63d15288730a8dea7f408db97a760)), closes [#1370](https://github.com/anolilab/lunora/issues/1370) [Array#some](https://github.com/anolilab/Array/issues/some)

## @lunora/wire [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/wire@1.0.0-alpha.1...@lunora/wire@1.0.0-alpha.2) (2026-10-20)

### Bug Fixes

* **shard-engine:** correct unique-index, rank, FK and parsed-write handling ([#1264](https://github.com/anolilab/lunora/issues/1264)) ([067708e](https://github.com/anolilab/lunora/commit/067708e4c8f823a363d77809a77d4386041efdfc))

## @lunora/wire 1.0.0-alpha.1 (2026-10-15)

### Performance Improvements

* **wire:** publish the wire codec once instead of inlining it into every package ([#1198](https://github.com/anolilab/lunora/issues/1198)) ([7020e2c](https://github.com/anolilab/lunora/commit/7020e2cec53c3e5c0f28ab8e569b33ee0ae3a55b))
