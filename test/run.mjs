// Local test: server code against sample pages (test/fixtures) with a mocked Instatic API.
// Usage: node test/run.mjs [-v]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const plugin = await import(pathToFileURL(path.join(root, 'src/server/index.js')).href);
const verbose = process.argv.includes('-v');
const DOMAIN = 'https://www.example.com';

// Add the Static SEO marker like the component renders it
function page(file, marker) {
  const h = fs.readFileSync(path.join(root, 'test/fixtures', file), 'utf8');
  const attrs = Object.entries(marker).map(([k, v]) => ` data-sseo-${k}="${v}"`).join('');
  return h.replace('<body>', () => `<body><div hidden="" data-sseo="1"${attrs}></div>`);
}

// Mocked storage
const store = {
  config: [{ id: 'c1', data: { key: 'main', json: JSON.stringify({
    domain: DOMAIN, siteName: 'Your Studio', locale: 'en_US',
    defaultImage: '/uploads/social-default.jpg', defaultImageAlt: 'Your Studio',
    noindexPaths: ['/imprint/', '/privacy/'],
    org: { type: 'ProfessionalService', name: 'Your Studio Ltd & Co', telephone: '+49 30 1234567', street: 'Example Street 1', postalCode: '10115', locality: 'Berlin', country: 'DE', openingHours: ['Mo-Fr 09:00-17:00'] }
  }) } }],
  pages: [
    { id: 'p1', data: { path: '/contact/', title: 'Contact & directions | Your Studio Berlin', description: 'Give us a call.' } },
    { id: 'p2', data: { path: '/services/repairs/', noindex: true } }
  ],
  index: [],
  entries: [],
  faqs: []
};
let nextId = 1;
let listCalls = 0;
const coll = (id) => ({
  list: async (o = {}) => {
    const limit = o.limit || 50;
    if (limit > 1000) throw new Error('limit too large');
    const off = o.offset || 0;
    listCalls++;
    return { records: store[id].slice(off, off + limit), totalCount: store[id].length };
  },
  create: async (data) => { const r = { id: 'n' + nextId++, data }; store[id].push(r); return r; },
  update: async (rid, data) => { const r = store[id].find((x) => x.id === rid); r.data = data; return r; }
});
let filter, before, sitemapRoute, statusRoute;
const api = {
  plugin: { id: 'staticseo.core', log: (m) => console.log('[log]', m) },
  cms: {
    storage: { collection: coll },
    hooks: { filter: (n, h) => { filter = h; }, on: (n, h) => { before = h; } },
    routes: { public: { get: (p, h) => { sitemapRoute = h; } }, authenticated: { get: (p, h) => { statusRoute = h; } } }
  }
};
plugin.activate(api);

let failed = 0;
const check = (name, ok) => { if (!ok) failed++; console.log(ok ? '  ✓' : '  ✗', name); };
const head = (h) => h.slice(h.indexOf('<title>'), h.indexOf('</head>'));
const setConfig = (obj) => { store.config[0].data = { key: 'main', json: JSON.stringify(obj) }; };
const getConfig = () => JSON.parse(store.config[0].data.json);

const cases = [
  ['home.html', { slug: 'index' }, { path: '/', 'page-title': 'Home', 'entry-id': '{currentEntry.id}' }, (h) => {
    check('home keeps site title', h.includes('<title>Your Studio – Design and build in Berlin</title>'));
    check('og:url /', h.includes(`og:url" content="${DOMAIN}/"`));
    check('marker removed', !h.includes('data-sseo'));
    check('organization schema', h.includes('"ProfessionalService"') && h.includes('Ltd \\u0026') === false);
    check('no breadcrumb on home', !h.includes('BreadcrumbList'));
  }],
  ['imprint.html', { slug: 'imprint' }, { path: '/imprint/', 'page-title': 'Imprint' }, (h) => {
    check('noindex by path', h.includes('noindex, follow'));
    check('no canonical when noindex', !h.includes('rel="canonical"'));
    check('title pattern', h.includes('<title>Imprint | Your Studio</title>'));
  }],
  ['service.html', { slug: 'template-service' }, {
    path: '/services/web-design/', 'page-title': 'Web &amp; App Design', 'entry-id': 'w1', 'entry-title': 'Web &amp; App Design',
    'entry-seo-title': 'Web &amp; App Design | Studio in Berlin', 'entry-seo-description': 'Websites and apps for small businesses.',
    'entry-image': '/uploads/abc-web.webp 640w, /uploads/abc-web-w1024.webp 1024w'
  }, (h) => {
    check('entry seo title', h.includes('<title>Web &amp; App Design | Studio in Berlin</title>'));
    check('entry url', h.includes(`og:url" content="${DOMAIN}/services/web-design/"`));
    check('entry image from featuredMedia', h.includes(`og:image" content="${DOMAIN}/uploads/abc-web.webp"`));
    check('breadcrumb 3 levels', /"position":3/.test(h));
  }],
  ['service.html', { slug: 'template-service' }, { path: '/services/repairs/', 'entry-id': 'r1', 'entry-title': 'Repairs', 'entry-seo-title': '{currentEntry.seoTitle}' }, (h) => {
    check('noindex via override', h.includes('noindex, follow'));
    check('title from entry name', h.includes('<title>Repairs | Your Studio</title>'));
  }],
  ['home.html', { slug: 'about', bind: true }, { path: '/about/', 'page-title': 'About &amp; team' }, (h) => {
    check('org telephone from data binding (tel: stripped)', h.includes('"telephone":"+49301234567"'));
    check('opening hours list from binding', h.includes('"openingHours":["Mo-Fr 09:00-17:00","Sa 10:00-14:00"]'));
    check('page image from binding', h.includes(`og:image" content="${DOMAIN}/uploads/team.jpg"`));
    check('binding attributes stripped', !/data-sseo-/.test(h));
  }],
  ['home.html', { slug: 'contact' }, { path: '/contact/', 'page-title': 'Contact &amp; directions' }, (h) => {
    check('override title + description', h.includes('<title>Contact &amp; directions | Your Studio Berlin</title>') && h.includes('content="Give us a call."'));
  }]
];

await before();
for (const [file, ctx, marker, test] of cases) {
  console.log('▸', file, marker.path);
  let src = page(file, marker);
  if (ctx.bind) src = src.replace('<footer', '<footer data-sseo-org-telephone="tel:+49301234567" data-sseo-org-opening-hours="Mo-Fr 09:00-17:00; Sa 10:00-14:00" data-sseo-org-email="{currentEntry.empty}"').replace('<main', '<main data-sseo-image="/uploads/team.jpg"');
  const out = await filter(src, ctx);
  test(out);
  check('idempotent', (await filter(out, ctx)) === out);
  if (verbose) console.log(head(out));
}

console.log('▸ sitemap + status');
const sm = await sitemapRoute();
check('200 xml', sm.status === 200 && sm.headers['content-type'].startsWith('application/xml'));
check('home + service + contact listed', ['/</loc>', '/services/web-design/', '/contact/'].every((p) => sm.body.includes(p)));
check('noindex pages excluded', !sm.body.includes('/imprint/') && !sm.body.includes('/repairs/'));
const st = await statusRoute();
check('status', st.configured === true && st.indexedUrls === 6);
if (verbose) console.log(sm.body, st);

console.log('▸ content types + synced entry data');
{
  setConfig({
    ...getConfig(),
    postTypes: { services: { routeBase: '/services', titlePattern: '{title} – Services {sep} {site}', index: true, sitemap: true, schemaType: 'Service' } },
    orgFromData: { email: 'hello@example.com', street: 'Example Street 1' }
  });
  store.entries.push(
    { id: 'e1', data: { path: '/services/maintenance/', table: 'services', noindex: true, description: 'Ongoing **maintenance** plans.' } },
    { id: 'e2', data: { path: '/services/branding/', table: 'services', noindex: false, description: 'Logos and visual identity.' } }
  );
  await before();
  const maint = await filter(page('service.html', { path: '/services/maintenance/', 'entry-id': 'm1', 'entry-title': 'Maintenance' }), { slug: 'template-service' });
  check('title pattern per post type', maint.includes('<title>Maintenance – Services | Your Studio</title>'));
  check('noindex from synced field rule', maint.includes('noindex, follow'));
  check('description from synced fallback field', maint.includes('content="Ongoing maintenance plans."'));
  const br = await filter(page('service.html', { path: '/services/branding/', 'entry-id': 'b1', 'entry-title': 'Branding' }), { slug: 'template-service' });
  check('Service node linked as mainEntity', br.includes('"@type":"Service"') && br.includes('"mainEntity"') && br.includes('"provider"'));
  check('org values synced from CMS table', br.includes('"email":"hello@example.com"') && br.includes('"streetAddress":"Example Street 1"'));
  const sm2 = await sitemapRoute();
  check('noindex entry not in sitemap', !sm2.body.includes('/services/maintenance/') && sm2.body.includes('/services/branding/'));
  const cfg2 = getConfig();
  cfg2.postTypes.services.sitemap = false;
  setConfig(cfg2);
  await before();
  check('post type excluded from sitemap', !(await sitemapRoute()).body.includes('/services/'));
  cfg2.postTypes.services.sitemap = true;
  setConfig(cfg2);
  await before();
}

console.log('▸ page audit + organization details');
{
  const rec = store.index.find((r) => r.data.path === '/');
  const a = JSON.parse(rec.data.audit || '{}');
  check('audit recorded (h1, words, images)', a.h1 === 1 && a.words > 100 && a.images > 0 && a.missingAlt === 1);
  check('description source recorded', a.descSource === 'site');
  const c = getConfig();
  c.org = { ...c.org, areaServed: ['Berlin', 'Brandenburg'], knowsAbout: ['Web design'], foundingDate: '2010' };
  setConfig(c);
  await before();
  const h = await filter(page('home.html', { path: '/', 'page-title': 'Home' }), { slug: 'index' });
  check('areaServed, knowsAbout, foundingDate', h.includes('"areaServed":[{"@type":"Place","name":"Berlin"}') && h.includes('"knowsAbout":["Web design"]') && h.includes('"foundingDate":"2010"'));
}

console.log('▸ FAQPage from synced FAQ data');
{
  store.faqs.push({ id: 'f1', data: { path: '/services/branding/', source: 'repeater:services.faq', items: JSON.stringify([{ q: 'How long does a **project** take?', a: 'Usually four to eight weeks.' }, { q: 'Empty', a: '' }]) } });
  await before();
  const br = await filter(page('service.html', { path: '/services/branding/', 'entry-id': 'b1', 'entry-title': 'Branding' }), { slug: 'template-service' });
  check('FAQPage with question and answer', br.includes('"@type":"FAQPage"') && br.includes('"name":"How long does a project take?"') && br.includes('"text":"Usually four to eight weeks."'));
  check('incomplete Q&A skipped', !br.includes('"name":"Empty"'));
  const c = getConfig(); c.faq = { enabled: false, sources: [] };
  setConfig(c);
  await before();
  const off = await filter(page('service.html', { path: '/services/branding/', 'entry-id': 'b1', 'entry-title': 'Branding' }), { slug: 'template-service' });
  check('FAQ schema can be switched off', !off.includes('FAQPage'));
  c.faq = { enabled: true, sources: [] }; setConfig(c);
  await before();
}

console.log('▸ discourage search engines (staging)');
const cfgObj = getConfig();
setConfig({ ...cfgObj, discourageSearch: true });
await before();
const staged = await filter(page('home.html', { path: '/about/', 'page-title': 'About' }), { slug: 'about' });
check('noindex, nofollow on every page', staged.includes('content="noindex, nofollow"'));
check('no canonical while hidden', !staged.includes('rel="canonical"'));
check('sitemap disabled', (await sitemapRoute()).status === 404);
check('status reports it', (await statusRoute()).discourageSearch === true);

setConfig(cfgObj);
await before();

console.log('▸ security hardening');
{
  const { jsonLd, merge, defaults } = plugin.__test;
  const ld = jsonLd({ name: '</script><script>alert(1)</script><!--' });
  check('JSON-LD cannot close or comment out the script block', !/<\/script>.*<\/script>/.test(ld) && !ld.slice(1, -9).includes('<'));
  const m = merge(defaults, { sitemap: 'false', defaultImageWidth: '800', noindexPaths: '/a/\n/b/', siteName: { evil: 1 }, org: 'x', titleSeparator: 5 });
  check('settings are coerced to their default types', m.sitemap === false && m.defaultImageWidth === 800 && m.noindexPaths.length === 2 && m.siteName === '' && m.org.type === 'Organization' && m.titleSeparator === '5');

  const c = getConfig();
  setConfig({ ...c, domain: 'javascript:alert(1)//', org: { ...c.org, sameAs: ['https://www.linkedin.com/company/x', 'javascript:alert(1)'] } });
  await before();
  const bad = await filter(page('home.html', { path: '/about/', 'page-title': 'About' }), { slug: 'about' });
  check('invalid domain is ignored (no canonical, no og:url)', !bad.includes('rel="canonical"') && !bad.includes('og:url') && !bad.includes('javascript:'));

  setConfig({ ...c, org: { ...c.org, sameAs: ['https://www.linkedin.com/company/x', 'javascript:alert(1)'] }, postTypes: { services: { routeBase: '/services', titlePattern: '{title} {sep} {site}', schemaType: 'Service' } } });
  await before();
  const sa = await filter(page('home.html', { path: '/', 'page-title': 'Home' }), { slug: 'index' });
  check('sameAs keeps only web URLs', sa.includes('linkedin.com/company/x') && !sa.includes('javascript:'));
  const dollar = await filter(page('service.html', { path: '/services/dollar/', 'entry-id': 'd1', 'entry-title': "Prices $&amp; $' costs" }), { slug: 'template-service' });
  check('title pattern keeps $ characters literally', dollar.includes("<title>Prices $&amp; $' costs | Your Studio</title>"));

  const two = page('home.html', { path: '/two/', 'page-title': 'Two' }).replace('</footer>', '</footer><div hidden="" data-sseo="1" data-sseo-path="/two/"></div>');
  check('a second component copy is removed too', !(await filter(two, { slug: 'two' })).includes('data-sseo'));

  const noMainEnd = page('home.html', { path: '/open/', 'page-title': 'Open' }).replace('</main>', '');
  await filter(noMainEnd, { slug: 'open' });
  const rec = store.index.find((r) => r.data.path === '/open/');
  check('audit counts words when </main> is missing', JSON.parse(rec.data.audit).words > 50);
  setConfig(c);
  await before();
}

console.log('▸ performance + large sites');
{
  await before();
  listCalls = 0;
  for (let i = 0; i < 5; i++) await filter(page('home.html', { path: '/perf-' + i + '/', 'page-title': 'P' + i }), { slug: 'perf-' + i });
  check('each page reads storage at most 5 times', listCalls <= 25);
  listCalls = 0;
  await sitemapRoute(); await sitemapRoute(); await sitemapRoute();
  check('repeated sitemap requests are served from cache', listCalls <= 3);

  // A setting changed right after the config was read elsewhere must reach every page,
  // whether or not publish.before fires
  await statusRoute(); await sitemapRoute();
  const c = getConfig();
  setConfig({ ...c, discourageSearch: true });
  await statusRoute(); await sitemapRoute();
  setConfig({ ...c, discourageSearch: false });
  const robots = [];
  for (const p of ['/', '/features/', '/about/']) {
    const out = await filter(page('home.html', { path: p, 'page-title': 'X' }), { slug: p === '/' ? 'index' : p.replace(/\//g, '') });
    robots.push(/content="noindex, nofollow"/.test(out));
  }
  check('setting changed without publish.before reaches every page', robots.every((x) => x === false));

  // CMS values synced by the admin live in their own record and win over the copy in "main"
  store.config.push({ id: 'c2', data: { key: 'orgFromData', json: JSON.stringify({ email: 'sync@example.com' }) } });
  const synced = await filter(page('home.html', { path: '/', 'page-title': 'Home' }), { slug: 'index' });
  check('orgFromData record is used', synced.includes('"email":"sync@example.com"'));
  store.config.pop();
  check('status reports hook counters', typeof (await statusRoute()).hooks.filter === 'number');

  for (let i = 0; i < 2500; i++) store.index.push({ id: 'big' + i, data: { path: '/blog/post-' + i + '/', kind: 'page', lastSeen: '2026-10-01T00:00:00Z' } });
  await before();
  const big = await sitemapRoute();
  check('sitemap includes records beyond the first 1000', big.body.includes('/blog/post-2499/') && big.body.includes('/blog/post-0/'));
  const before2 = store.index.length;
  await filter(page('home.html', { path: '/blog/post-2400/', 'page-title': 'Post' }), { slug: 'blog/post-2400' });
  check('known URL beyond 1000 is updated, not duplicated', store.index.length === before2);
}

console.log(failed ? `\n${failed} failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
