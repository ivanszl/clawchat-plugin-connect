---
status: accepted
---

# Source Connect Client locale from its entrypoint with Astryx

Connect Client uses one of Simplified Chinese, Traditional Chinese, English, Japanese, Spanish, or Korean across local, trusted-LAN, and Liveware Exposure entrypoints. A valid `lang` query supplied by the entrypoint takes precedence and is retained unchanged across Client routes, browser language is the fallback source, and English is the final fallback; the resolved locale is fixed for one page load and Connect keeps no independent language preference.

Connect uses Astryx `InternationalizationProvider` and `useTranslator` as its single translation runtime for both `@connect.*` product copy and `@astryx.*` component copy. Astryx currently ships no complete first-party catalog for the five target non-English locales, so Connect owns those translations locally instead of merely importing them from Astryx. All six catalogs ship in the SPA, English is the source catalog, non-English catalogs completely cover both namespaces, and catalog parity is a release check; this avoids a second i18next provider and prevents Liveware from depending on runtime translation downloads. Future first-party Astryx translations may replace matching local `@astryx.*` messages after review, without changing the runtime architecture.

## Considered Options

- `i18next` with `react-i18next` was rejected because Astryx already supplies ICU message formatting, locale fallback, pseudo-localization, and the component-internal translation context that Connect must use anyway.
- A Connect-owned language setting was rejected because it could conflict with the ClawChat or browser language that selected the entrypoint locale.
