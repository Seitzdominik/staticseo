# StaticSEO

SEO for [Instatic](https://github.com/CoreBunch/Instatic), written straight into your static HTML. While your site is published, StaticSEO adds everything search engines, social networks and AI assistants look for, so crawlers see it without running any JavaScript.

**What ends up in your HTML**

- `<title>` and meta description for every page and post entry
- `robots` (incl. noindex per page, per rule or site-wide) and canonical links
- Open Graph and Twitter Card tags with image, size and alt text
- JSON-LD: Organization, WebSite, WebPage, BreadcrumbList, Service/Article/Product per post type, FAQPage
- An XML sitemap of all indexable pages

You manage it all in one **SEO** workspace in the Instatic admin, plus an SEO panel in the site editor. Company details, entry fields and FAQs can come straight from your CMS tables, so nothing is maintained twice.

Website: [staticseo.co](https://staticseo.co)

## Requirements

Instatic with plugin support (plugin API version 1).

## Installation

1. Download the latest `static-seo-<version>.zip` from [Releases](../../releases).
2. In Instatic, go to **Admin → Plugins → Upload Plugin** and upload the ZIP.
3. Open your layout template in the site editor and add the **“Static SEO”** component once (Insert → Components). It renders nothing visible; it tells the plugin which page or entry is being published.
4. Open **Admin → SEO** and fill in the basics: domain, site name, default social image, your business details.
5. Publish the site.

### About the `editor.code` permission

Instatic marks `editor.code` as “dangerous” during installation. StaticSEO only needs it for its own admin screens (the SEO workspace and the editor panel). It makes no external requests.

### Sitemap

Instatic serves plugin routes below `/admin/api/…`, so the sitemap lives at:

```
https://your-domain.com/admin/api/cms/plugins/staticseo.core/runtime/sitemap.xml
```

Submit that URL in Google Search Console, or forward `/sitemap.xml` to it (for example with a Cloudflare redirect rule).

### Upgrading

Upload the new version over the old one – Instatic upgrades in place. **Don't uninstall first:** uninstalling deletes all plugin data. If you do need to uninstall, export a backup first (SEO → Settings → Import / export).

## Privacy

StaticSEO adds no scripts, no cookies and no tracking to your site, and makes no external requests. Everything it outputs is plain HTML in the `<head>`, written at publish time. All data stays in your Instatic installation.

## Status

Beta. A side project, maintained in my spare time. Issues and PRs are welcome, but responses may take a while.

## Contributing

Bug reports and pull requests are welcome. For larger changes, please open an issue first so we can talk about the approach.

```bash
node test/run.mjs   # server tests (Node 22+)
node build.mjs      # checks the code and builds dist/static-seo-<version>.zip
```

Architecture notes and Instatic quirks: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE) © 2026 Dominik Seitz

The name StaticSEO and its logo are not covered by the MIT license.
