# Changelog

All notable changes to StaticSEO. Versions follow the `version` in `src/plugin.json`.

## 0.9.0 – 2026-10-15

- **Open source under the MIT license** (previously a free beta license).
- Workspace header shows “Open source · MIT” instead of “Free during beta”.
- Tests now use neutral sample pages.

## 0.8.4 – 2026-10-14

- Fixed: a setting changed right before publishing could reach only some pages. The publish filter now reads fresh data for every page.
- The CMS sync stores copied company details in their own record and never rewrites the main settings; syncs run one after another, and publishing waits for a running sync.
- `/status` reports how often the publish hooks ran (diagnostics).
- Support address: support@staticseo.co.

## 0.8.3 – 2026-10-13

- Storage is read page by page (Instatic returns max. 1000 records per request) – fixes truncated sitemaps and duplicate URL records on large sites.
- JSON-LD escapes every `<`, so no field can close the script block.
- Settings are checked against their expected types (also on import); the domain must be an http(s) URL, `sameAs` keeps only http(s) URLs, imported page entries are validated.
- Title patterns insert `$` characters literally.
- URLs of deleted or unpublished pages leave the sitemap automatically.
- Faster CMS sync (parallel table loading, batched writes); a table that can't be read stops the sync instead of being treated as empty.
- The public sitemap is cached for 60 seconds.

## 0.8.0 – 0.8.2 – 2026-10-13

- Sidebar navigation on every tab, one tab per post type, grouped schema sections.
- Media library picker for the logo; manual value shown when a mapped CMS value isn't usable.
- Feedback link, homepage and author in the manifest.

## 0.7.0 – 0.7.1 – 2026-10-13

- Redesigned workspace: Overview dashboard with setup checklist, Pages list with filters, page editor with Google and social previews, fixed save bar.

## 0.6.0 – 0.6.1 – 2026-10-13

- GEO/AEO: `max-snippet:-1` / `max-image-preview:large`, publish and modified dates, area served, expertise, founding date.
- Page audit on every publish (title/description length, H1 count, missing alt texts, thin content).
- Beta badge.

## 0.5.0 – 2026-10-13

- FAQPage schema from repeater fields of post types or rows of a data table.

## 0.4.0 – 0.4.1 – 2026-10-13

- Content types: rules per post type (search visibility, sitemap, title pattern, schema type, fallback description, noindex by field).
- Publish button in the workspace.

## 0.3.0 – 2026-10-13

- Import / export of settings and page entries.
- Staging mode (“Discourage search engines”).

## 0.2.0 – 0.2.1 – 2026-10-13

- First general release: one SEO workspace, site editor panel, “Static SEO” component, Organization/WebSite/WebPage/Breadcrumb schema, XML sitemap, company details from CMS tables.
