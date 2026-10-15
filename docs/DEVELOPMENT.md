# Development notes

## How it works

| Piece | File | Runs in |
|---|---|---|
| Publish filter, sitemap, status route | `src/server/index.js` | Instatic plugin sandbox (QuickJS) |
| SEO workspace | `src/admin/app.js` | Admin (React from the host import map, plain ESM) |
| Site editor panel | `src/editor/index.js` | Site editor (same) |
| “Static SEO” component | `src/pack/site.json` | Imported on install |
| Manifest | `src/plugin.json` | – |

- **Page context:** the `publish.html` filter doesn't know which URL it renders (for entries, `pageId`/`slug` are the template's). The component, placed once in the layout template, renders a hidden `<div data-sseo="1">` with `{route.path}` and `{currentEntry.*}` attributes. The filter reads and removes it.
- **Storage** (plugin resources): `config` (settings JSON, plus a separate `orgFromData` record written by the CMS sync), `pages` (per-URL overrides), `index` (published URLs + audit facts), `entries` (synced entry/page data), `faqs` (synced FAQ items per path).
- **CMS sync:** the admin app copies company details, per-entry data (noindex rule result, fallback description, dates, author) and FAQs from CMS tables into plugin storage when the workspace opens, on save and before publishing from it.
- **Value order** for title/description/image: per-URL override → data binding on the page → entry SEO fields (`seoTitle`, `seoDescription`, `featuredMedia`) → title pattern → previous value.

## Commands

- `node test/run.mjs [-v]` – server tests with sample pages (`test/fixtures`) and a mocked Instatic API. Needs Node 22+.
- `node build.mjs` – checks forbidden sandbox literals, `export var` and strict ESM syntax; writes `dist/static-seo-<version>.zip`.
- Bump `version` in `src/plugin.json` for every release (same `id`, higher version = in-place upgrade).
- Check a package without installing it: as a logged-in admin, `POST /admin/api/cms/plugins/inspect-package` with FormData `file`.

## Releasing

Push a tag that matches the manifest version, e.g. `v0.9.0`. The GitHub Action in `.github/workflows/release.yml` runs the tests, builds the ZIP and attaches it to a GitHub Release.

## Instatic quirks (as of October 2026)

- `publish.before` fires before **every page**, not once per publish (`server/publish/publishedHtmlPipeline.ts`). The filter reads fresh data for every page anyway.
- `api.cms.content.republishAll()` runs the pipeline but discards the HTML – the workspace uses `POST /admin/api/cms/publish` (step-up protected) instead.
- `publish.headers` is declared but never applied.
- Plugin routes only exist below `/admin/api/cms/plugins/<id>/runtime/` – no `/sitemap.xml` or `/robots.txt` at the root.
- Plugin records: max. `limit=1000` per request, `offset` + `totalCount` for paging. `PATCH` replaces the whole record; `false`, `''` and `null` are stored as missing. The data rows API ignores `limit`/`offset`.
- Sandbox: `export var` isn't rewritten by Instatic's ESM shim (use `export const`/`export function`); literals like `'node:` or `require(` are rejected (checked by `build.mjs`).
- Host UI components pass the value to `onChange`, not the event.
- Settings `PUT` needs step-up, so the plugin declares no `settings[]` and stores its configuration in plugin records.
- Uninstall deletes all plugin data; uploading a higher version upgrades in place.
- After installing or upgrading, open site editor tabs must be reloaded to get the SEO panel.
- Custom media fields only return the media ID in templates – use `featuredMedia` for entry images.
