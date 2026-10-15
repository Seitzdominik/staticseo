/*
 * Static SEO – server entry (runs inside the Instatic plugin sandbox, QuickJS).
 *
 * 1. Filter `publish.html`: writes title, description, robots, canonical, Open Graph,
 *    Twitter and JSON-LD into the static HTML of every published page.
 * 2. Public route `/sitemap.xml` (under /admin/api/cms/plugins/staticseo.core/runtime/).
 * 3. Authenticated route `/status` for the admin app.
 *
 * Page context comes from the "Static SEO" component (pack/site.json), placed once in
 * the site's layout template. It renders a hidden <div data-sseo="1" …> with the route
 * path and entry fields; the filter reads and removes it.
 *
 * Storage (plugin resources):
 *   config  – one record { key: "main", json: "<settings JSON>" }
 *   pages   – per-URL overrides { path, title, description, image, noindex }
 *   index   – URLs seen while publishing { path, title, kind, noindex, lastSeen } (sitemap + Pages tab)
 */

var MARKER = '<!-- static-seo -->';

var DEFAULTS = {
  domain: '',
  siteName: '',
  titleSeparator: '|',
  locale: 'en_US',
  trailingSlash: true,
  discourageSearch: false,
  richPreviews: true,
  postTypes: {},
  orgFromData: {},
  faq: { enabled: true, sources: [] },
  canonical: true,
  defaultImage: '',
  defaultImageWidth: 1200,
  defaultImageHeight: 630,
  defaultImageAlt: '',
  twitterSite: '',
  noindexPaths: [],
  sitemap: true,
  schemaWebsite: true,
  schemaBreadcrumb: true,
  schemaOrganization: true,
  org: {
    type: 'Organization', name: '', description: '', logo: '', telephone: '', email: '',
    street: '', postalCode: '', locality: '', region: '', country: '', openingHours: [], sameAs: [],
    areaServed: [], knowsAbout: [], foundingDate: ''
  }
};

// ------------------------------------------------------------------ helpers

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

// Unresolved tokens ({currentEntry.x}) count as empty
function val(v) {
  var t = str(v);
  return t && t.indexOf('{') !== 0 ? t : '';
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decode(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&amp;/g, '&');
}

function plain(v) {
  if (v === undefined || v === null || typeof v === 'object') return '';
  return decode(String(v))
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s, max) {
  if (s.length <= max) return s;
  var t = s.slice(0, max - 1);
  var i = t.lastIndexOf(' ');
  return (i > max * 0.6 ? t.slice(0, i) : t).replace(/[\s,.;:–-]+$/, '') + '…';
}

function lines(v) {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  return str(v).split(/\r?\n/).map(function (z) { return z.trim(); }).filter(Boolean);
}

// Every "<" escaped: no </script>, <!-- or <script> sequence can survive inside the block
function jsonLd(obj) {
  var json = JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return '<script type="application/ld+json">' + json + '</script>';
}

// Stored values must have the type of their default (imports or manual edits may not)
function coerce(b, o) {
  if (o === undefined || o === null || o === '') return b;
  if (Array.isArray(b)) return Array.isArray(o) ? o : typeof o === 'string' ? lines(o) : b;
  if (typeof b === 'boolean') return typeof o === 'boolean' ? o : o === 'true' ? true : o === 'false' ? false : b;
  if (typeof b === 'number') { var n = Number(o); return isFinite(n) ? n : b; }
  if (typeof b === 'string') return typeof o === 'string' || typeof o === 'number' ? String(o) : b;
  return o;
}

function merge(base, over) {
  var out = {};
  if (!over || typeof over !== 'object') over = {};
  Object.keys(base).forEach(function (k) {
    var b = base[k];
    var o = over[k];
    var isObj = b && typeof b === 'object' && !Array.isArray(b);
    // Empty default objects (postTypes, orgFromData) are free-form maps – take them as stored
    if (isObj && !Object.keys(b).length) out[k] = o && typeof o === 'object' && !Array.isArray(o) ? o : b;
    else if (isObj) out[k] = merge(b, o);
    else out[k] = coerce(b, o);
  });
  return out;
}

// Replacement text taken literally ("$&" or "$1" in a title must not be expanded)
function fill(template, map) {
  return str(template).replace(/\{(title|site|sep)\}/g, function (all, key) { return map[key]; });
}

function absolute(cfg, pathOrUrl) {
  var p = str(pathOrUrl);
  if (!p) return '';
  if (/^https?:\/\//i.test(p)) return p;
  if (!cfg.domain) return '';
  return cfg.domain + (p.charAt(0) === '/' ? '' : '/') + p;
}

function normPath(cfg, p) {
  var t = str(p) || '/';
  t = t.split('?')[0].split('#')[0];
  if (t.charAt(0) !== '/') t = '/' + t;
  t = t.replace(/\/{2,}/g, '/');
  if (t === '/') return '/';
  t = t.replace(/\/+$/, '');
  if (/\.[a-z0-9]{2,5}$/i.test(t)) return t;
  return cfg.trailingSlash ? t + '/' : t;
}

function pathMatches(pattern, path, cfg) {
  var m = str(pattern);
  if (!m) return false;
  if (m.charAt(m.length - 1) === '*') return path.indexOf(normPath(cfg, m.slice(0, -1)).replace(/\/$/, '')) === 0;
  return normPath(cfg, m) === path;
}

function firstUrl(v) {
  // featuredMedia may render as "path 320w, path 640w" or plain path
  var t = val(v);
  if (!t) return '';
  var m = t.match(/(https?:\/\/[^\s,"]+|\/[^\s,"]+)/);
  return m ? m[1] : '';
}

// ------------------------------------------------------------------ storage

function collection(api, id) {
  return api.cms.storage.collection(id);
}

// Instatic returns at most 1000 records per request – page through larger collections
var PAGE_SIZE = 1000;

async function listAll(api, id) {
  var out = [];
  try {
    for (var n = 0; n < 100; n++) {
      var r = await collection(api, id).list({ limit: PAGE_SIZE, offset: out.length });
      var recs = (r && r.records) || [];
      // Guard: a host that ignores offset would return the first page again
      if (n && recs.length && out.length && recs[0].id === out[0].id) break;
      out = out.concat(recs);
      var total = r && typeof r.totalCount === 'number' ? r.totalCount : out.length;
      if (recs.length < PAGE_SIZE || out.length >= total) break;
    }
  } catch (e) {
    /* partial result is better than none */
  }
  return out;
}

// ------------------------------------------------------------------ caches
//
// The publish filter and the /status route always read fresh data (caches are reset at the
// start of every call): a setting saved a second before publishing must reach every page.
// Only the public sitemap route serves from these caches (60 s), so bots can't trigger
// storage reads on every request.
var CACHE_TTL = 60000;
var cacheAt = 0;
var configCache = null;
var overridesCache = null;
var sitemapCache = null;

function resetCaches() {
  cacheAt = Date.now();
  configCache = null; overridesCache = null; sitemapCache = null;
  indexCache = null; entryCacheMap = null; faqCacheMap = null;
}

function checkCacheAge() {
  if (Date.now() - cacheAt > CACHE_TTL) resetCaches();
}

var DOMAIN_RE = /^https?:\/\/[^\s/?#"'<>\\]+(\/[^\s?#"'<>\\]*)?$/i;

async function loadConfig(api) {
  checkCacheAge();
  if (configCache) return JSON.parse(JSON.stringify(configCache));
  var recs = await listAll(api, 'config');
  var rec = recs.filter(function (r) { return r.data && r.data.key === 'main'; })[0];
  var raw = {};
  if (rec && rec.data && rec.data.json) {
    try { raw = JSON.parse(rec.data.json); } catch (e) { raw = {}; }
  }
  // CMS values copied by the admin sync live in their own record, so the sync never
  // rewrites the main settings (0.8.4+); older installs keep them inside "main"
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  var synced = recs.filter(function (r) { return r.data && r.data.key === 'orgFromData'; })[0];
  if (synced && synced.data && synced.data.json) {
    try { raw.orgFromData = JSON.parse(synced.data.json); } catch (e) { /* keep main's copy */ }
  }
  var cfg = merge(DEFAULTS, raw);
  cfg.domain = str(cfg.domain).replace(/\/+$/, '');
  // Only a plain http(s) origin is used for canonical, og:url, schema and the sitemap
  if (!DOMAIN_RE.test(cfg.domain)) cfg.domain = '';
  configCache = cfg;
  return JSON.parse(JSON.stringify(cfg));
}

async function loadOverrides(api) {
  checkCacheAge();
  if (!overridesCache) overridesCache = (await listAll(api, 'pages')).map(function (r) { return r.data || {}; });
  return overridesCache;
}

// Index of published URLs (for the sitemap and the Pages tab)
var indexCache = null;

async function ensureIndex(api) {
  checkCacheAge();
  if (!indexCache) {
    indexCache = {};
    (await listAll(api, 'index')).forEach(function (r) { if (r.data && r.data.path) indexCache[r.data.path] = r; });
  }
  return indexCache;
}

async function upsertIndex(api, item) {
  await ensureIndex(api);
  var existing = indexCache[item.path];
  try {
    if (existing) {
      var d = existing.data || {};
      var changed = d.audit !== item.audit || d.title !== item.title || d.name !== item.name || d.via !== item.via || d.kind !== item.kind || !!d.noindex !== !!item.noindex;
      // lastSeen only needs refreshing once per hour
      var stale = !d.lastSeen || Date.parse(item.lastSeen) - Date.parse(d.lastSeen) > 3600000;
      if (changed || stale) {
        var upd = await collection(api, 'index').update(existing.id, item);
        indexCache[item.path] = upd || { id: existing.id, data: item };
      }
    } else {
      var made = await collection(api, 'index').create(item);
      indexCache[item.path] = made || { id: '', data: item };
    }
  } catch (e) {
    indexCache = null;
  }
}

// ------------------------------------------------------------------ content types

// Post type whose route base is the longest prefix of the path
function postTypeFor(cfg, path) {
  var pts = cfg.postTypes || {};
  var best = null;
  var bestLen = 0;
  Object.keys(pts).forEach(function (k) {
    var p = pts[k] || {};
    var base = '/' + str(p.routeBase || k).replace(/^\/+|\/+$/g, '');
    if (base === '/') return;
    if (path.indexOf(base + '/') === 0 && base.length > bestLen) {
      best = p; bestLen = base.length; best.slug = k;
    }
  });
  return best;
}

var entryCacheMap = null;

async function entryCache(api, path) {
  checkCacheAge();
  if (!entryCacheMap) {
    entryCacheMap = {};
    (await listAll(api, 'entries')).forEach(function (r) { if (r.data && r.data.path) entryCacheMap[r.data.path] = r.data; });
  }
  return entryCacheMap[path] || null;
}

// FAQ items per path, synced by the admin app from repeaters or data tables
var faqCacheMap = null;

async function faqFor(api, path) {
  checkCacheAge();
  if (!faqCacheMap) {
    faqCacheMap = {};
    (await listAll(api, 'faqs')).forEach(function (r) {
      if (!r.data || !r.data.path) return;
      try { faqCacheMap[r.data.path] = JSON.parse(r.data.items || '[]'); } catch (e) { faqCacheMap[r.data.path] = []; }
    });
  }
  return faqCacheMap[path] || [];
}

function faqNode(url, items) {
  var qs = (items || []).map(function (it) {
    var q = plain(it && it.q);
    var a = plain(it && it.a);
    return q && a ? { '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } } : null;
  }).filter(Boolean);
  return qs.length ? { '@type': 'FAQPage', '@id': url + '#faq', url: url, mainEntity: qs } : null;
}

var ARTICLE_TYPES = { Article: 1, BlogPosting: 1, NewsArticle: 1 };

// Main entity for an entry page (Article family or Service), linked from the WebPage node
function contentTypeNode(pt, o) {
  var type = pt && str(pt.schemaType);
  if (!type || type === 'WebPage') return null;
  var node = { '@type': type, '@id': o.url + '#' + type.toLowerCase(), name: o.name, url: o.url };
  if (o.desc) node.description = o.desc;
  if (o.image) node.image = o.image;
  if (ARTICLE_TYPES[type]) {
    node.headline = o.name;
    node.mainEntityOfPage = { '@id': o.url + '#webpage' };
    if (o.cache && o.cache.datePublished) node.datePublished = o.cache.datePublished;
    if (o.cache && o.cache.dateModified) node.dateModified = o.cache.dateModified;
    if (o.cache && o.cache.author) node.author = { '@type': 'Person', name: o.cache.author };
    if (o.orgId) node.publisher = { '@id': o.orgId };
  } else if (type === 'Service') {
    if (o.orgId) node.provider = { '@id': o.orgId };
  } else if (o.orgId) {
    node.brand = { '@id': o.orgId };
  }
  return node;
}

// ------------------------------------------------------------------ page audit

// Facts about the published page for the Pages tab (issues are derived in the admin app)
function auditPage(html, title, desc, descSource) {
  var bodyAt = html.indexOf('<body');
  var body = bodyAt >= 0 ? html.slice(bodyAt) : html;
  var mainStart = body.indexOf('<main');
  var mainEnd = mainStart >= 0 ? body.indexOf('</main>', mainStart) : -1;
  var scope = mainStart < 0 ? body : mainEnd < 0 ? body.slice(mainStart) : body.slice(mainStart, mainEnd + 7);
  var text = scope.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
  text = decode(text).replace(/\s+/g, ' ').trim();
  var imgs = body.match(/<img\b[^>]*>/gi) || [];
  return {
    h1: (body.match(/<h1\b/gi) || []).length,
    words: text ? text.split(' ').length : 0,
    images: imgs.length,
    missingAlt: imgs.filter(function (t) { return !/\salt=/i.test(t); }).length,
    emptyAlt: imgs.filter(function (t) { return /\salt=""/i.test(t); }).length,
    titleLength: (title || '').length,
    descLength: (desc || '').length,
    descSource: descSource
  };
}

// ------------------------------------------------------------------ marker

// Every copy is removed (component placed twice); the first one provides the values
var MARKER_RE_ALL = /<div\b[^>]*\sdata-sseo="1"[^>]*>\s*<\/div>/g;

function readMarker(html) {
  var m = html.match(/<div\b[^>]*\sdata-sseo="1"[^>]*>\s*<\/div>/);
  if (!m) return null;
  var tag = m[0].slice(0, m[0].indexOf('>') + 1);
  var out = { raw: m[0] };
  var re = /\sdata-sseo-([a-z-]+)="([^"]*)"/g;
  var a;
  while ((a = re.exec(tag))) out[a[1]] = decode(a[2]);
  return out;
}

// ------------------------------------------------------------------ data bindings
//
// Any element may carry data-sseo-<key>="{token}" attributes, e.g. inside a loop over a
// data table ("company details") or in a post-type template. Instatic resolves the tokens
// on publish, so values always come from the CMS – no double maintenance.
// The first non-empty value per key wins; all binding attributes are removed from the output.

var BINDING_KEYS = {
  'title': 'title', 'description': 'description', 'image': 'image', 'noindex': 'noindex',
  'org-name': 'name', 'org-description': 'description', 'org-logo': 'logo', 'org-telephone': 'telephone',
  'org-email': 'email', 'org-street': 'street', 'org-postal-code': 'postalCode', 'org-locality': 'locality',
  'org-region': 'region', 'org-country': 'country', 'org-opening-hours': 'openingHours', 'org-same-as': 'sameAs'
};

var lastBindings = {};

function readBindings(html) {
  var found = {};
  var re = /\sdata-sseo-([a-z-]+)="([^"]*)"/g;
  var a;
  while ((a = re.exec(html))) {
    var key = a[1];
    if (!BINDING_KEYS[key] || found[key] !== undefined) continue;
    var v = val(decode(a[2]));
    if (v) found[key] = v;
  }
  return found;
}

function stripBindings(html) {
  return html.replace(/\sdata-sseo-(title|description|image|noindex|org-[a-z-]+)="[^"]*"/g, '');
}

function cleanContact(v) {
  return str(v).replace(/^(tel|mailto):/i, '');
}

function splitList(v) {
  return str(v).split(/\r?\n|;|\s\|\s/).map(function (x) { return x.trim(); }).filter(Boolean);
}

// ------------------------------------------------------------------ filter

async function processPage(api, html, ctx) {
  if (typeof html !== 'string' || html.indexOf('</head>') < 0 || html.indexOf(MARKER) >= 0) return html;
  var cfg = await loadConfig(api);
  var mk = readMarker(html);
  var via = mk ? 'component' : 'slug';
  var out = mk ? html.replace(MARKER_RE_ALL, '') : html;
  mk = mk || {};
  // Most pages carry no binding attributes – skip both scans then
  var hasBindings = out.indexOf('data-sseo-') >= 0;
  var bind = hasBindings ? readBindings(out) : {};
  if (hasBindings) out = stripBindings(out);
  if (Object.keys(bind).length) lastBindings = { keys: Object.keys(bind), at: new Date().toISOString() };
  // Organization fields bound to CMS data override the stored values
  var orgBound = {};
  Object.keys(bind).forEach(function (k) {
    if (k.indexOf('org-') !== 0) return;
    var f = BINDING_KEYS[k];
    var v = bind[k];
    if (f === 'telephone' || f === 'email') v = cleanContact(v);
    orgBound[f] = f === 'openingHours' || f === 'sameAs' ? splitList(v) : v;
  });
  // Order: stored fields < values synced from a CMS table by the admin app < live attributes
  cfg.org = merge(merge(cfg.org, cfg.orgFromData || {}), orgBound);

  var slug = ctx && ctx.slug ? ctx.slug : '';
  var isEntry = !!val(mk['entry-id']);
  var path = val(mk.path) ? normPath(cfg, mk.path) : (slug && !isEntry ? (slug === 'index' ? '/' : normPath(cfg, '/' + slug)) : '');
  var isHome = path === '/';

  // Content type rules (configured per post type) and the entry cache synced by the admin app
  var pt = isEntry && path ? postTypeFor(cfg, path) : null;
  var cache = path ? await entryCache(api, path) : null;
  if (cache && !isEntry && cache.table !== 'pages') cache = null;

  var tm = out.match(/<title>([^<]*)<\/title>/);
  var dm = out.match(/<meta name="description" content="([^"]*)"\s*\/?>/);
  var oldTitle = tm ? decode(tm[1]) : '';
  var oldDesc = dm ? decode(dm[1]) : '';

  var ov = {};
  if (path) {
    var overrides = await loadOverrides(api);
    for (var i = 0; i < overrides.length; i++) {
      if (pathMatches(overrides[i].path, path, cfg)) { ov = overrides[i]; break; }
    }
  }

  var name = isEntry ? val(mk['entry-title']) : val(mk['page-title']);
  var pattern = function (t) {
    if (pt && str(pt.titlePattern)) {
      return fill(pt.titlePattern, { title: t, site: cfg.siteName, sep: cfg.titleSeparator }).replace(/\s+/g, ' ').trim();
    }
    return cfg.siteName ? t + ' ' + cfg.titleSeparator + ' ' + cfg.siteName : t;
  };

  var title = val(ov.title) || val(bind.title) || (isEntry ? val(mk['entry-seo-title']) : '');
  if (!title && name && !isHome) title = pattern(name);
  title = title || oldTitle || cfg.siteName;

  var descSource = val(ov.description) ? 'page' : plain(bind.description) ? 'binding' : (isEntry && plain(mk['entry-seo-description'])) ? 'entry' : (cache && plain(cache.description)) ? 'fallback' : oldDesc ? 'site' : 'none';
  var desc = val(ov.description) || plain(bind.description) || (isEntry ? plain(mk['entry-seo-description']) : '') || (cache ? plain(cache.description) : '') || oldDesc;
  desc = truncate(desc, 160);

  var image = absolute(cfg, ov.image) || absolute(cfg, firstUrl(bind.image));
  if (!image && isEntry) image = absolute(cfg, firstUrl(mk['entry-image']));
  var isDefaultImage = !image;
  if (!image) image = absolute(cfg, cfg.defaultImage);

  var noindex = ov.noindex === true || ov.noindex === 'true' || /^(true|1|yes|noindex)$/i.test(str(bind.noindex));
  if (!noindex && path) noindex = lines(cfg.noindexPaths).some(function (p) { return pathMatches(p, path, cfg); });
  if (!noindex && pt && pt.index === false) noindex = true;
  if (!noindex && cache && (cache.noindex === true || cache.noindex === 'true')) noindex = true;

  var url = cfg.domain && path ? cfg.domain + path : '';

  // <title> and description
  var tags = [MARKER];
  if (title) {
    var t = '<title>' + escAttr(title) + '</title>';
    if (tm) out = out.replace(tm[0], function () { return t; }); else tags.push(t);
  }
  if (desc) {
    var dd = '<meta name="description" content="' + escAttr(desc) + '">';
    if (dm) out = out.replace(dm[0], function () { return dd; }); else tags.push(dd);
  }
  // Staging: keep the whole site out of search engines
  var hidden = cfg.discourageSearch === true;
  if (hidden) tags.push('<meta name="robots" content="noindex, nofollow">');
  else if (noindex) tags.push('<meta name="robots" content="noindex, follow">');
  // Allow long snippets and large image previews (search results, AI overviews)
  else if (cfg.richPreviews !== false) tags.push('<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">');
  if (url && cfg.canonical && !noindex && !hidden) tags.push('<link rel="canonical" href="' + escAttr(url) + '">');

  function meta(attr, key, content) {
    if (str(content)) tags.push('<meta ' + attr + '="' + key + '" content="' + escAttr(content) + '">');
  }
  meta('property', 'og:site_name', cfg.siteName);
  meta('property', 'og:type', 'website');
  meta('property', 'og:locale', cfg.locale);
  meta('property', 'og:title', title);
  meta('property', 'og:description', desc);
  meta('property', 'og:url', url);
  if (image) {
    meta('property', 'og:image', image);
    if (isDefaultImage) {
      meta('property', 'og:image:width', cfg.defaultImageWidth);
      meta('property', 'og:image:height', cfg.defaultImageHeight);
    }
    meta('property', 'og:image:alt', isDefaultImage ? cfg.defaultImageAlt : title);
  }
  meta('name', 'twitter:card', image ? 'summary_large_image' : 'summary');
  meta('name', 'twitter:site', cfg.twitterSite);
  meta('name', 'twitter:title', title);
  meta('name', 'twitter:description', desc);
  meta('name', 'twitter:image', image);

  // JSON-LD @graph
  var graph = [];
  var org = cfg.org || {};
  if (cfg.domain) {
    var orgId = cfg.domain + '/#organization';
    var siteId = cfg.domain + '/#website';
    var hasOrg = cfg.schemaOrganization && (org.name || cfg.siteName);
    if (hasOrg) {
      var o = { '@type': str(org.type) || 'Organization', '@id': orgId, name: org.name || cfg.siteName, url: cfg.domain + '/' };
      if (org.description) o.description = org.description;
      var area = lines(org.areaServed);
      if (area.length) o.areaServed = area.map(function (a) { return { '@type': 'Place', name: a }; });
      var knows = lines(org.knowsAbout);
      if (knows.length) o.knowsAbout = knows;
      if (str(org.foundingDate)) o.foundingDate = str(org.foundingDate);
      if (org.logo) o.logo = absolute(cfg, org.logo);
      if (cfg.defaultImage) o.image = absolute(cfg, cfg.defaultImage);
      if (org.telephone) o.telephone = org.telephone;
      if (org.email) o.email = org.email;
      if (org.street || org.locality) {
        o.address = { '@type': 'PostalAddress' };
        if (org.street) o.address.streetAddress = org.street;
        if (org.postalCode) o.address.postalCode = org.postalCode;
        if (org.locality) o.address.addressLocality = org.locality;
        if (org.region) o.address.addressRegion = org.region;
        if (org.country) o.address.addressCountry = org.country;
      }
      var oh = lines(org.openingHours);
      if (oh.length) o.openingHours = oh;
      var sa = lines(org.sameAs).filter(function (u) { return /^https?:\/\/\S+$/i.test(u); });
      if (sa.length) o.sameAs = sa;
      graph.push(o);
    }
    if (cfg.schemaWebsite) {
      var ws = { '@type': 'WebSite', '@id': siteId, url: cfg.domain + '/', name: cfg.siteName || org.name };
      if (cfg.locale) ws.inLanguage = str(cfg.locale).replace('_', '-');
      if (hasOrg) ws.publisher = { '@id': orgId };
      graph.push(ws);
      if (url && !noindex) {
        var wp = { '@type': 'WebPage', '@id': url + '#webpage', url: url, name: title, isPartOf: { '@id': siteId } };
        if (cache && cache.datePublished) wp.datePublished = cache.datePublished;
        if (cache && cache.dateModified) wp.dateModified = cache.dateModified;
        if (cfg.locale) wp.inLanguage = str(cfg.locale).replace('_', '-');
        if (desc) wp.description = desc;
        if (image && !isDefaultImage) wp.primaryImageOfPage = { '@type': 'ImageObject', url: image };
        if (cfg.schemaBreadcrumb && !isHome) wp.breadcrumb = { '@id': url + '#breadcrumb' };
        graph.push(wp);
        var main = contentTypeNode(pt, { url: url, name: name || title, desc: desc, image: isDefaultImage ? '' : image, cache: cache, orgId: hasOrg ? orgId : '' });
        if (main) { wp.mainEntity = { '@id': main['@id'] }; graph.push(main); }
        if (!cfg.faq || cfg.faq.enabled !== false) {
          var fq = faqNode(url, await faqFor(api, path));
          if (fq) { fq.isPartOf = { '@id': url + '#webpage' }; graph.push(fq); }
        }
      }
    }
    if (cfg.schemaBreadcrumb && url && !isHome && !noindex) {
      await ensureIndex(api);
      var segs = path.replace(/^\/|\/$/g, '').split('/');
      var items = [{ '@type': 'ListItem', position: 1, name: 'Home', item: cfg.domain + '/' }];
      var acc = '';
      for (var s = 0; s < segs.length - 1; s++) {
        acc += '/' + segs[s];
        var parentPath = normPath(cfg, acc);
        var parent = indexCache && indexCache[parentPath];
        var parentName = parent && parent.data && parent.data.name ? parent.data.name : segs[s].charAt(0).toUpperCase() + segs[s].slice(1).replace(/-/g, ' ');
        items.push({ '@type': 'ListItem', position: items.length + 1, name: parentName, item: cfg.domain + parentPath });
      }
      items.push({ '@type': 'ListItem', position: items.length + 1, name: name || title, item: url });
      graph.push({ '@type': 'BreadcrumbList', '@id': url + '#breadcrumb', itemListElement: items });
    }
  }
  if (graph.length) tags.push(jsonLd({ '@context': 'https://schema.org', '@graph': graph }));

  out = out.replace('</head>', function () { return '  ' + tags.join('\n  ') + '\n</head>'; });

  if (path) {
    await upsertIndex(api, {
      audit: JSON.stringify(auditPage(out, title, desc, descSource)),
      path: path, title: title, name: name || title, kind: isEntry ? 'entry' : 'page',
      noindex: noindex, lastSeen: new Date().toISOString(), via: via
    });
  }
  return out;
}

// ------------------------------------------------------------------ sitemap

// Public route: the rendered body is cached, so repeated requests cost no storage reads
async function buildSitemap(api) {
  checkCacheAge();
  if (sitemapCache) return sitemapCache;
  var res = await renderSitemap(api);
  if (res.status === 200) sitemapCache = res;
  return res;
}

async function renderSitemap(api) {
  var cfg = await loadConfig(api);
  if (!cfg.sitemap || !cfg.domain || cfg.discourageSearch === true) {
    return { __response: true, status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Sitemap disabled or domain not set.' };
  }
  var overrides = await loadOverrides(api);
  var noindexPaths = lines(cfg.noindexPaths);
  var idx = await ensureIndex(api);
  var urls = Object.keys(idx)
    .map(function (p) { return idx[p].data || {}; })
    .filter(function (d) {
      if (!d.path || d.noindex === true || d.noindex === 'true') return false;
      if (noindexPaths.some(function (p) { return pathMatches(p, d.path, cfg); })) return false;
      var ptype = d.kind === 'entry' ? postTypeFor(cfg, d.path) : null;
      if (ptype && (ptype.sitemap === false || ptype.index === false)) return false;
      return !overrides.some(function (o) { return (o.noindex === true || o.noindex === 'true') && pathMatches(o.path, d.path, cfg); });
    })
    .sort(function (a, b) { return a.path < b.path ? -1 : 1; });
  var body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(function (u) {
      return '  <url><loc>' + escXml(cfg.domain + u.path) + '</loc>' + (u.lastSeen ? '<lastmod>' + escXml(String(u.lastSeen).slice(0, 10)) + '</lastmod>' : '') + '</url>';
    }).join('\n') + '\n</urlset>\n';
  return { __response: true, status: 200, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' }, body: body };
}

// ------------------------------------------------------------------ lifecycle

// Diagnostics for /status: how often the hooks ran since the plugin worker started
var hookStats = { before: 0, filter: 0, lastBefore: null, lastFilter: null };

export function activate(api) {
  api.cms.hooks.filter('publish.html', async function (html, ctx) {
    hookStats.filter++; hookStats.lastFilter = new Date().toISOString();
    try {
      // Fresh data for every page, whether or not publish.before fired
      resetCaches();
      return await processPage(api, html, ctx);
    } catch (e) {
      api.plugin.log('Static SEO: filter failed – ' + (e && e.message ? e.message : e));
      return html;
    }
  });

  api.cms.hooks.on('publish.before', function () {
    hookStats.before++; hookStats.lastBefore = new Date().toISOString();
    resetCaches();
  });

  api.cms.routes.public.get('/sitemap.xml', async function () {
    try {
      return await buildSitemap(api);
    } catch (e) {
      api.plugin.log('Static SEO: sitemap failed – ' + (e && e.message ? e.message : e));
      return { __response: true, status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Sitemap could not be generated.' };
    }
  });

  api.cms.routes.authenticated.get('/status', async function () {
    resetCaches();
    var cfg = await loadConfig(api);
    var idx = (await listAll(api, 'index')).map(function (r) { return r.data || {}; });
    var last = idx.reduce(function (m, d) { return d.lastSeen && d.lastSeen > m ? d.lastSeen : m; }, '');
    return {
      configured: !!(cfg.domain && cfg.siteName),
      discourageSearch: cfg.discourageSearch === true,
      bindings: lastBindings,
      componentSeen: idx.some(function (d) { return d.via === 'component'; }),
      urlsWithoutComponent: idx.filter(function (d) { return d.via !== 'component'; }).map(function (d) { return d.path; }).slice(0, 20),
      indexedUrls: idx.length,
      lastPublishSeen: last || null,
      sitemapPath: '/admin/api/cms/plugins/' + api.plugin.id + '/runtime/sitemap.xml',
      hooks: hookStats
    };
  });
}

// For local tests only (ignored by Instatic)
export const __test = { processPage: processPage, buildSitemap: buildSitemap, readMarker: readMarker, jsonLd: jsonLd, merge: merge, defaults: DEFAULTS, reset: resetCaches };
