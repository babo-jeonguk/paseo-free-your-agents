# Third-party notices

Free Your Agents is MIT licensed, except for the provider logo artwork described below.

At runtime, Paseo supplies the plugin SDK, React, React Native, TanStack Query and Zod. Development dependencies retain their own licenses.

## Provider logo artwork

The Claude and Codex (OpenAI) logo paths in `assets/provider-icons/` come from
[Paseo](https://github.com/getpaseo/paseo/tree/fc8f085b9e128b7ccd54ef4900501c195cc1c8a1/packages/app/assets/icons).
Copyright (c) 2025-present Mohamed Boudra. Paseo's Apache-2.0 license and third-party
terms are reproduced in `assets/provider-icons/LICENSE.txt`. The SVG paths are
unchanged; `client/provider-logos.ts` contains transparent 80px PNG conversions for
20px display through React Native Image, tinted using the current theme.
