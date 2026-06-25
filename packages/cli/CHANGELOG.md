## @lunora/cli [1.0.0-alpha.11](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.10...@lunora/cli@1.0.0-alpha.11) (2026-06-25)

### Bug Fixes

* **cli:** align progress bar and fix overwrite ([7ce48fd](https://github.com/anolilab/lunora/commit/7ce48fd3e59e64d93a9e23d0b49b5b7e9f4e33fe))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.4
* **@lunora/config:** upgraded to 1.0.0-alpha.6
* **@lunora/seed:** upgraded to 1.0.0-alpha.2

## @lunora/cli [1.0.0-alpha.10](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.9...@lunora/cli@1.0.0-alpha.10) (2026-06-25)

### Features

* **cli:** rebuild init DX in create-astro style ([36638dc](https://github.com/anolilab/lunora/commit/36638dc6b08978509da90861f3b9292205c10300))

### Bug Fixes

* remove not needed package ([d254595](https://github.com/anolilab/lunora/commit/d254595cbc0eb689724fecb87345dbbb30a2245f))


### Dependencies

* **@lunora/config:** upgraded to 1.0.0-alpha.5

## @lunora/cli [1.0.0-alpha.9](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.8...@lunora/cli@1.0.0-alpha.9) (2026-06-24)

### Features

* **cli:** prompt for binding values on init/add instead of shipping placeholders ([f7538db](https://github.com/anolilab/lunora/commit/f7538dbc3e43ad94416e86255976a94606228e16))

## @lunora/cli [1.0.0-alpha.8](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.7...@lunora/cli@1.0.0-alpha.8) (2026-06-24)

### Features

* **r2sql:** typed R2 SQL client with window functions, DISTINCT and set ops ([#26](https://github.com/anolilab/lunora/issues/26)) ([fe9546b](https://github.com/anolilab/lunora/commit/fe9546bb3473875d47939bf93e6fbb81084a07aa))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.3
* **@lunora/config:** upgraded to 1.0.0-alpha.4
* **@lunora/d1:** upgraded to 1.0.0-alpha.4

## @lunora/cli [1.0.0-alpha.7](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.6...@lunora/cli@1.0.0-alpha.7) (2026-06-23)

### Bug Fixes

* **templates:** replace hardcoded worker port with VITE_LUNORA_URL env ([98e539d](https://github.com/anolilab/lunora/commit/98e539de32acf07c2cabd1ce73c5e52522dae3a1))

## @lunora/cli [1.0.0-alpha.6](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.5...@lunora/cli@1.0.0-alpha.6) (2026-06-23)

### Features

* **cli:** branded init flow — name prompt, spinners, install offer ([fcdfee4](https://github.com/anolilab/lunora/commit/fcdfee450b1ee26b1c9733c50919821dc13e79ed))
* **cli:** create-vite overlay init for SPA frameworks ([fd394c1](https://github.com/anolilab/lunora/commit/fd394c17583dea3059344c2c04188f8cee32e506))
* **cli:** extend the init feature offer beyond auth + email ([e3c4507](https://github.com/anolilab/lunora/commit/e3c4507889e3787b76c61214faacedc163cce5e5))
* **cli:** interactive template picker, ASCII title, non-interactive guard ([ac3f7f3](https://github.com/anolilab/lunora/commit/ac3f7f3c0d2b3d8374a5ff4829810d3f54d60e0d))
* **cli:** offer analog and react-router in the init picker ([8da95b1](https://github.com/anolilab/lunora/commit/8da95b1769c3e759e7bf18a0ed616d9ec44f5fde))

### Bug Fixes

* **cli:** clearer non-interactive init error + tidy test name ([b477b26](https://github.com/anolilab/lunora/commit/b477b26d068d67b5669b025c0b3d0fd2fbff6d7b))
* **cli:** install dependencies as the last init step ([185108d](https://github.com/anolilab/lunora/commit/185108de3ac6138230e286e2d430fb1ecd0d32e8))
* fixed packem config ([633cfe6](https://github.com/anolilab/lunora/commit/633cfe6bb0a3c05e6b00607340013e957c0000bb))
* **templates:** conform vite-react template; stabilize cli deploy CI test ([39d7a0e](https://github.com/anolilab/lunora/commit/39d7a0eccfc8a98154e1a0c66d97956d3273a6ae))

### Documentation

* **cli:** design for the create-vite overlay init engine ([4d196dc](https://github.com/anolilab/lunora/commit/4d196dcf7cc19d560b62bbd40543960376d1942f))

### Code Refactoring

* **cli:** drop bespoke vite-react template, default to create-vite overlay ([bebf7e7](https://github.com/anolilab/lunora/commit/bebf7e7f3c47f3309a59377fb8e75299b1c503ab))

## @lunora/cli [1.0.0-alpha.5](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.4...@lunora/cli@1.0.0-alpha.5) (2026-06-22)

### Features

* **cli:** branded TUI wizard, spinners, searchable lists, all confirms ([4333e01](https://github.com/anolilab/lunora/commit/4333e01e4808d568a3115af4beae9d8f09562562))
* **cli:** rebuild the vite template into a working realtime starter ([ad9ec90](https://github.com/anolilab/lunora/commit/ad9ec907eb56ecebddd2b44f9f0344146258241a))
* **cli:** rich @visulima/tui prompts for init/add selection ([964c7ef](https://github.com/anolilab/lunora/commit/964c7efb02735bbf1d5ad2d5755e5d334cec1fb6))

### Bug Fixes

* **cli:** address thermos review of the TUI prompts ([4777356](https://github.com/anolilab/lunora/commit/47773569f2d6c1870729bde3b837a46a1b70e257))

### Code Refactoring

* **cli:** rename the vite template to vite-react ([05a0573](https://github.com/anolilab/lunora/commit/05a057371581cc7f10bf050f07325be2f71870aa))

## @lunora/cli [1.0.0-alpha.4](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.3...@lunora/cli@1.0.0-alpha.4) (2026-06-22)

### Bug Fixes

* **cli:** make scaffolded projects installable ([7f0d172](https://github.com/anolilab/lunora/commit/7f0d172f6629cc1ac836ea862206e1bab23ef9ff))

## @lunora/cli [1.0.0-alpha.3](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.2...@lunora/cli@1.0.0-alpha.3) (2026-06-22)

### Features

* **cli:** add --ref to init and registry commands ([ffe26aa](https://github.com/anolilab/lunora/commit/ffe26aa726babb9f587ac3403856fc35ce60e4f9))

### Miscellaneous Chores

* **deps:** wire fallow into every package ([896a81d](https://github.com/anolilab/lunora/commit/896a81d39a064293234bba3b734cde1036e81a67))

### Code Refactoring

* remove dead code flagged by fallow ([be57eca](https://github.com/anolilab/lunora/commit/be57ecaf4d6f3bc95d7b1a5876305dfb2af80e45))

## @lunora/cli [1.0.0-alpha.2](https://github.com/anolilab/lunora/compare/@lunora/cli@1.0.0-alpha.1...@lunora/cli@1.0.0-alpha.2) (2026-06-22)

### Documentation

* fix homepage/cli scaffold command to lunorash@alpha ([8b69b5a](https://github.com/anolilab/lunora/commit/8b69b5af1ad8c2fd6f8bbc96292bc05cc067ffd7))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.2
* **@lunora/config:** upgraded to 1.0.0-alpha.2
* **@lunora/d1:** upgraded to 1.0.0-alpha.2

## @lunora/cli 1.0.0-alpha.1 (2026-06-21)

### Features

* publish all packages publicly for the initial alpha release ([91781b4](https://github.com/anolilab/lunora/commit/91781b485bf7a9891805c6851fe393de5f87ef40))

### Styles

* format source with prettier and ignore generated artifacts ([c63b52a](https://github.com/anolilab/lunora/commit/c63b52a05578b8476cf627babe246acd9730c0f9))

### Miscellaneous Chores

* lunora start ([786b573](https://github.com/anolilab/lunora/commit/786b5735d986bca4df64ccf642273a085bf7d574))
* normalize package.json key order ([d7a25f0](https://github.com/anolilab/lunora/commit/d7a25f00e0f665dd113ad17e98081b9bd69a1989))

### Build System

* **deps:** update @visulima/* packages to latest alpha ([b1c1f14](https://github.com/anolilab/lunora/commit/b1c1f140f79b1804c12ea4e4b08b3ebe5d3e39ef))


### Dependencies

* **@lunora/codegen:** upgraded to 1.0.0-alpha.1
* **@lunora/config:** upgraded to 1.0.0-alpha.1
* **@lunora/container:** upgraded to 1.0.0-alpha.1
* **@lunora/d1:** upgraded to 1.0.0-alpha.1
* **@lunora/seed:** upgraded to 1.0.0-alpha.1
* **@lunora/server:** upgraded to 1.0.0-alpha.1
* **@lunora/studio:** upgraded to 1.0.0-alpha.1
* **@lunora/values:** upgraded to 1.0.0-alpha.1
