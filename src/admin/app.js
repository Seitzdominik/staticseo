// Static SEO – admin workspace (one "SEO" page in the Instatic admin).
// Plain ESM, no build step: React and host UI come from the admin's import map.
import { createElement as h, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { usePluginRoutes } from '@instatic/host-hooks';
import {
  Tabs, TabList, Tab, TabPanel, Input, Textarea, Switch, Select, Button, Card, Stack,
  Heading, Text, Alert, SearchBar, EmptyState, Separator
} from '@instatic/host-ui';

// Feedback link shown next to the beta badge (leave empty to hide)
const FEEDBACK_URL = 'mailto:support@staticseo.co?subject=Static%20SEO%20feedback';

// ------------------------------------------------------------------ defaults (keep in sync with server)

const DEFAULTS = {
  domain: '', siteName: '', titleSeparator: '|', locale: 'en_US', trailingSlash: true, discourageSearch: false, richPreviews: true, canonical: true, postTypes: {}, orgFromData: {}, faq: { enabled: true, sources: [] },
  defaultImage: '', defaultImageWidth: 1200, defaultImageHeight: 630, defaultImageAlt: '', twitterSite: '',
  noindexPaths: [], sitemap: true, schemaWebsite: true, schemaBreadcrumb: true, schemaOrganization: true,
  org: { type: 'Organization', name: '', description: '', logo: '', telephone: '', email: '', street: '', postalCode: '', locality: '', region: '', country: '', openingHours: [], sameAs: [], areaServed: [], knowsAbout: [], foundingDate: '' },
  // UI state of the data-binding helper (not used by the server)
  bindings: { table: '', fields: {} }
};

// Organization properties that can be bound to CMS fields → data-sseo-org-* attribute names
const BINDABLE = [
  ['name', 'Legal name', 'org-name'], ['telephone', 'Phone', 'org-telephone'], ['email', 'Email', 'org-email'],
  ['street', 'Street and number', 'org-street'], ['postalCode', 'Postal code', 'org-postal-code'], ['locality', 'City', 'org-locality'],
  ['region', 'Region / state', 'org-region'], ['country', 'Country', 'org-country'], ['openingHours', 'Opening hours', 'org-opening-hours'],
  ['sameAs', 'Profiles (sameAs)', 'org-same-as'], ['logo', 'Logo', 'org-logo'], ['description', 'Description', 'org-description']
];

const LOCALES = ['en_US', 'en_GB', 'de_DE', 'de_AT', 'de_CH', 'fr_FR', 'es_ES', 'it_IT', 'nl_NL', 'pl_PL', 'pt_PT', 'pt_BR', 'sv_SE', 'da_DK', 'nb_NO', 'fi_FI', 'cs_CZ'];
const ORG_TYPES = ['Organization', 'Corporation', 'LocalBusiness', 'ProfessionalService', 'MedicalBusiness', 'MedicalClinic', 'Dentist', 'Physician', 'LegalService', 'AccountingService', 'FinancialService', 'RealEstateAgent', 'Restaurant', 'CafeOrCoffeeShop', 'Store', 'HomeAndConstructionBusiness', 'AutomotiveBusiness', 'HealthAndBeautyBusiness', 'SportsActivityLocation', 'LodgingBusiness', 'TravelAgency', 'EducationalOrganization', 'NGO'];

// Stored or imported values must have the type of their default
function coerce(b, o) {
  if (o === undefined || o === null) return b;
  if (Array.isArray(b)) return Array.isArray(o) ? o : typeof o === 'string' ? fromLines(o) : b;
  if (typeof b === 'boolean') return typeof o === 'boolean' ? o : o === 'true' ? true : o === 'false' ? false : b;
  if (typeof b === 'number') { const n = o === '' ? NaN : Number(o); return Number.isFinite(n) ? n : b; }
  if (typeof b === 'string') return typeof o === 'string' || typeof o === 'number' ? String(o) : b;
  return o;
}

function mergeDefaults(base, over) {
  const out = {};
  const src = over && typeof over === 'object' && !Array.isArray(over) ? over : {};
  for (const k of Object.keys(base)) {
    const b = base[k];
    const o = src[k];
    if (b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length) out[k] = mergeDefaults(b, o);
    else if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = o && typeof o === 'object' && !Array.isArray(o) ? o : b;
    else out[k] = coerce(b, o);
  }
  return out;
}

// Runs async jobs with limited parallelism (keeps the admin API responsive)
async function runLimited(jobs, limit = 4) {
  let i = 0;
  const worker = async () => { while (i < jobs.length) { const job = jobs[i++]; await job(); } };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

// ------------------------------------------------------------------ storage (plugin records REST API)

function recordsApi(pluginId) {
  const base = `/admin/api/cms/plugins/${encodeURIComponent(pluginId)}/resources/`;
  async function call(url, init) {
    const res = await fetch(url, { credentials: 'include', headers: { 'content-type': 'application/json' }, ...init });
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { /* no body */ }
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }
  return {
    list: async (rid) => {
      // Instatic returns at most 1000 records per request
      let out = [];
      for (let n = 0; n < 100; n++) {
        const r = await call(`${base}${rid}/records?limit=1000&offset=${out.length}`);
        const recs = (r && r.records) || [];
        out = out.concat(recs);
        const total = r && typeof r.totalCount === 'number' ? r.totalCount : out.length;
        if (recs.length < 1000 || out.length >= total) break;
      }
      return out;
    },
    create: async (rid, data) => (await call(`${base}${rid}/records`, { method: 'POST', body: JSON.stringify({ data }) })).record,
    update: async (rid, id, data) => (await call(`${base}${rid}/records/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ data }) })).record,
    remove: async (rid, id) => { await call(`${base}${rid}/records/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  };
}

// ------------------------------------------------------------------ CMS data (admin API, runs as the signed-in user)

async function fetchJson(url, init) {
  const res = await fetch(url, { credentials: 'include', ...init });
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { ok: res.ok, status: res.status, body };
}

async function listTables() {
  const r = await fetchJson('/admin/api/cms/data/tables');
  return r.ok && r.body ? r.body.tables || [] : [];
}

async function listPublishedRows(table) {
  const r = await fetchJson(`/admin/api/cms/data/tables/${encodeURIComponent(table.id)}/rows?limit=1000`);
  if (!r.ok || !r.body || !Array.isArray(r.body.rows)) throw new Error(`Could not read “${table.name || table.slug}” (${r.status})`);
  return r.body.rows.filter((row) => !row.deletedAt && (!row.status || row.status === 'published'));
}

function ruleMatches(c, cells) {
  if (!c || !c.noindexField) return false;
  const raw = cells ? cells[c.noindexField] : undefined;
  const actual = raw === undefined || raw === null ? '' : Array.isArray(raw) ? raw.join(',') : String(raw);
  const expected = String(c.noindexValue == null ? '' : c.noindexValue);
  // Booleans: a missing value counts as false
  const norm = (s) => (s === '' && (expected === 'true' || expected === 'false') ? 'false' : s);
  return c.noindexOp === '=' ? norm(actual) === expected : norm(actual) !== expected;
}

// schema.org openingHours: "Mo-Fr 07:00-17:00", "Sa 09:00-12:00", "Mo,We 08:00-12:00"
const DAY = '(Mo|Tu|We|Th|Fr|Sa|Su)';
const OPENING_HOURS_RE = new RegExp(`^${DAY}(-${DAY})?(,${DAY}(-${DAY})?)*( \\d{2}:\\d{2}-\\d{2}:\\d{2})?$`);
const COUNTRY_CODES = { DE: '49', AT: '43', CH: '41', LI: '423', LU: '352', NL: '31', BE: '32', FR: '33', IT: '39', ES: '34', GB: '44', DK: '45', PL: '48', CZ: '420' };

// National number → international format for schema (030 1234567 → +49 30 1234567)
function internationalPhone(v, country) {
  const s = String(v || '').trim();
  if (!s || s.startsWith('+')) return s;
  if (s.startsWith('00')) return '+' + s.slice(2);
  const cc = COUNTRY_CODES[String(country || '').toUpperCase()];
  return cc && /^0[1-9]/.test(s) ? `+${cc} ${s.slice(1)}` : s;
}

// Instatic stores false, '' and null as “missing” – compare records the same way
function sameRecord(a, b) {
  const norm = (v) => (v === false || v === '' || v === null || v === undefined ? null : v);
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if (JSON.stringify(norm((a || {})[k])) !== JSON.stringify(norm((b || {})[k]))) return false;
  return true;
}

function plainText(v) {
  if (v === undefined || v === null || typeof v === 'object') return '';
  return String(v).replace(/<[^>]+>/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
}

function entryPath(base, slug, trailingSlash) {
  const p = '/' + [String(base || '').replace(/^\/+|\/+$/g, ''), slug].filter(Boolean).join('/');
  return trailingSlash ? p + '/' : p;
}

// Copies CMS values into plugin storage: organization fields from the mapped table and
// per-entry data (noindex rule, fallback description, dates) for every post type.
async function syncCmsData({ api, saved, configId, tables, rowsByTable, index, lastPublishedAt }) {
  const result = { at: new Date().toISOString(), entries: 0, orgFromData: null, orgError: '' };

  // Organization values
  const b = saved.bindings || {};
  const orgFromData = {};
  if (b.table && b.fields && Object.values(b.fields).some(Boolean)) {
    const t = tables.find((x) => x.slug === b.table);
    const rows = t ? rowsByTable[t.slug] || (await listPublishedRows(t)) : [];
    const row = rows[0];
    if (!row) result.orgError = 'no published row found';
    else {
      for (const [k, fieldId] of Object.entries(b.fields)) {
        if (!fieldId) continue;
        let v = row.cells ? row.cells[fieldId] : undefined;
        if (v === undefined || v === null || typeof v === 'object') continue;
        v = String(v).trim();
        if (k === 'telephone' || k === 'email') v = v.replace(/^(tel|mailto):/i, '');
        if (k === 'telephone') v = internationalPhone(v, (saved.org || {}).country);
        if (k === 'openingHours' || k === 'sameAs') {
          const list = v.split(/\r?\n|;/).map((x) => x.trim()).filter(Boolean);
          if (k === 'openingHours' && !list.every((x) => OPENING_HOURS_RE.test(x))) {
            result.orgError = `opening hours “${v}” are not in schema.org format (e.g. Mo-Fr 07:00-17:00) – the manual value is used`;
            continue;
          }
          orgFromData[k] = list;
        } else orgFromData[k] = v;
      }
    }
  }
  result.orgFromData = orgFromData;
  // Own record: the sync never rewrites the main settings, so it can't undo a save made
  // while it was running (0.8.3 wrote the whole config from the snapshot it started with)
  const syncedJson = JSON.stringify(orgFromData);
  const syncedRec = (await api.list('config')).find((r) => r.data && r.data.key === 'orgFromData');
  if (!syncedRec) await api.create('config', { key: 'orgFromData', json: syncedJson });
  else if (syncedRec.data.json !== syncedJson) await api.update('config', syncedRec.id, { key: 'orgFromData', json: syncedJson });

  // Entry data
  const wanted = new Map();
  const pts = saved.postTypes || {};
  for (const t of tables.filter((x) => x.kind === 'postType')) {
    const c = pts[t.slug] || {};
    const rows = rowsByTable[t.slug] || (await listPublishedRows(t));
    for (const row of rows) {
      if (!row.slug) continue;
      const author = row.author && (row.author.name || row.author.displayName || row.author.email);
      const d = { path: entryPath(t.routeBase || t.slug, row.slug, saved.trailingSlash !== false), table: t.slug, noindex: ruleMatches(c, row.cells) };
      const desc = c.descriptionField ? plainText(row.cells && row.cells[c.descriptionField]) : '';
      if (desc) d.description = desc;
      if (row.publishedAt) d.datePublished = row.publishedAt;
      if (row.updatedAt) d.dateModified = row.updatedAt;
      if (author) d.author = String(author);
      wanted.set(d.path, d);
    }
  }
  const pagesTable = tables.find((x) => x.slug === 'pages');
  if (pagesTable) {
    const prow = rowsByTable.pages || (await listPublishedRows(pagesTable));
    for (const row of prow) {
      if (!row.slug || (row.cells && row.cells.templateEnabled)) continue;
      const path = row.slug === 'index' ? '/' : entryPath('', row.slug, saved.trailingSlash !== false);
      const d = { path, table: 'pages', noindex: false };
      if (row.publishedAt) d.datePublished = row.publishedAt;
      if (row.updatedAt) d.dateModified = row.updatedAt;
      wanted.set(path, d);
    }
  }
  const existing = await api.list('entries');
  const byPath = new Map(existing.map((r) => [r.data && r.data.path, r]));
  const jobs = [];
  for (const [path, d] of wanted) {
    const cur = byPath.get(path);
    if (!cur) jobs.push(() => api.create('entries', d));
    else if (!sameRecord(cur.data, d)) jobs.push(() => api.update('entries', cur.id, d));
  }
  for (const r of existing) if (!r.data || !wanted.has(r.data.path)) jobs.push(() => api.remove('entries', r.id));
  await runLimited(jobs);
  result.entries = wanted.size;

  // Published URLs of deleted or unpublished pages/entries leave the URL list and sitemap:
  // gone from the CMS and not rebuilt by the last publish (2 h margin, lastSeen is refreshed hourly)
  result.pruned = [];
  const cutoff = lastPublishedAt ? Date.parse(lastPublishedAt) - 2 * 3600000 : NaN;
  if (pagesTable && wanted.size && Number.isFinite(cutoff) && Array.isArray(index)) {
    const gone = index.filter((r) => r.data && r.data.path && !wanted.has(r.data.path) && r.data.lastSeen && Date.parse(r.data.lastSeen) < cutoff);
    await runLimited(gone.map((r) => () => api.remove('index', r.id)));
    result.pruned = gone.map((r) => r.id);
  }

  // FAQs (single source of truth: repeaters of post types or rows of a data table)
  const trailing = saved.trailingSlash !== false;
  const normPath = (p) => {
    let s = String(p || '').trim();
    if (!s) return '';
    if (!s.startsWith('/')) s = '/' + s;
    if (s === '/') return '/';
    s = s.replace(/\/+$/, '');
    return trailing ? s + '/' : s;
  };
  const faqByPath = new Map();
  const add = (path, src, items) => {
    if (!path || !items.length) return;
    const cur = faqByPath.get(path) || { sources: [], items: [] };
    if (!cur.sources.includes(src)) cur.sources.push(src);
    cur.items.push(...items);
    faqByPath.set(path, cur);
  };
  const qa = (cells, s) => ({ q: plainText(cells && cells[s.question]), a: plainText(cells && cells[s.answer]) });
  const faqCfg = saved.faq || {};
  for (const s of faqCfg.sources || []) {
    if (s.enabled === false || !s.table || !s.question || !s.answer) continue;
    const t = tables.find((x) => x.slug === s.table);
    if (!t) continue;
    const rows = rowsByTable[t.slug] || (await listPublishedRows(t));
    if (s.type === 'repeater') {
      if (!s.field) continue;
      for (const row of rows) {
        if (!row.slug) continue;
        const list = row.cells && Array.isArray(row.cells[s.field]) ? row.cells[s.field] : [];
        add(entryPath(t.routeBase || t.slug, row.slug, trailing), `repeater:${t.slug}.${s.field}`, list.map((it) => qa(it && it.cells ? it.cells : it, s)).filter((x) => x.q && x.a));
      }
    } else {
      const shared = [];
      for (const row of rows) {
        const it = qa(row.cells, s);
        if (!it.q || !it.a) continue;
        if (s.pathField) String((row.cells && row.cells[s.pathField]) || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean).forEach((p) => add(normPath(p), `table:${t.slug}`, [it]));
        else shared.push(it);
      }
      if (!s.pathField) for (const p of s.paths || []) add(normPath(p), `table:${t.slug}`, shared);
    }
  }
  const faqExisting = await api.list('faqs');
  const faqByExisting = new Map(faqExisting.map((r) => [r.data && r.data.path, r]));
  const faqJobs = [];
  for (const [path, v] of faqByPath) {
    const d = { path, source: v.sources.join(', '), items: JSON.stringify(v.items) };
    const cur = faqByExisting.get(path);
    if (!cur) faqJobs.push(() => api.create('faqs', d));
    else if (cur.data.items !== d.items || cur.data.source !== d.source) faqJobs.push(() => api.update('faqs', cur.id, d));
  }
  for (const r of faqExisting) if (!r.data || !faqByPath.has(r.data.path)) faqJobs.push(() => api.remove('faqs', r.id));
  await runLimited(faqJobs);
  result.faqPages = faqByPath.size;
  result.faqCount = [...faqByPath.values()].reduce((n, v) => n + v.items.length, 0);
  return result;
}

// Site publish (same endpoint as Instatic's own Publish button, step-up protected)
async function publishSite() {
  const r = await fetchJson('/admin/api/cms/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (r.ok) return { ok: true, pages: r.body && r.body.publishedPages };
  if (r.status === 401 && r.body && r.body.error === 'step_up_required') return { ok: false, stepUp: true };
  return { ok: false, error: (r.body && r.body.error) || `Publish failed (${r.status})` };
}

async function confirmPassword(password, mfaCode) {
  const body = { password };
  if (mfaCode) body.mfaCode = mfaCode;
  const r = await fetchJson('/admin/api/cms/auth/step-up', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) return { ok: true };
  const err = (r.body && (r.body.error || r.body.message)) || `Confirmation failed (${r.status})`;
  return { ok: false, error: err, mfa: /mfa|code|totp/i.test(String(err)) };
}

// ------------------------------------------------------------------ small UI helpers

const css = {
  page: { display: 'flex', flexDirection: 'column', gap: 'var(--space-l, 20px)', maxWidth: 1120, paddingBottom: 96 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  previewLabel: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)' },
  social: { borderRadius: 'var(--card-radius, 8px)', border: '1px solid var(--border-subtle)', background: 'var(--bg-surface-2)', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  socialImg: { width: '100%', aspectRatio: '1.91 / 1', objectFit: 'cover', display: 'block', background: 'var(--bg-surface-3)' },
  overlay: { position: 'fixed', inset: 0, background: 'var(--overlay-60, rgba(0,0,0,.6))', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 24 },
  dialog: { width: 'min(880px, 100%)', maxHeight: '85vh', overflow: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--panel-radius, 12px)', padding: 20, display: 'flex', flexDirection: 'column', gap: 14 },
  mediaGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 },
  mediaItem: { all: 'unset', cursor: 'pointer', padding: 6, borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg-surface-2)', textAlign: 'left' },
  cards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 },
  settingsGrid: { display: 'grid', gridTemplateColumns: 'minmax(160px, 200px) minmax(0, 1fr)', gap: 20, alignItems: 'start' },
  subnav: { display: 'flex', flexDirection: 'column', gap: 2, position: 'sticky', top: 16 },
  subnavItem: { all: 'unset', cursor: 'pointer', padding: '8px 12px', borderRadius: 8, fontSize: 13, color: 'var(--text-muted)' },
  subnavActive: { background: 'var(--bg-surface-3)', color: 'var(--text-bright)' },
  chip: { all: 'unset', cursor: 'pointer', fontSize: 12, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' },
  chipActive: { background: 'var(--bg-surface-3)', color: 'var(--text-bright)', borderColor: 'var(--border)' },
  split: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20, alignItems: 'start' },
  saveBar: { position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', width: 'min(760px, calc(100% - 48px))', zIndex: 50, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '12px 16px', borderRadius: 'var(--panel-radius, 12px)', background: 'var(--bg-surface-3)', border: '1px solid var(--border)', boxShadow: '0 8px 30px rgba(0,0,0,.35)' },

  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-m, 16px)' },
  muted: { color: 'var(--text-muted)' },
  row: { display: 'grid', gridTemplateColumns: '12px minmax(0, 1fr) auto', gap: 12, alignItems: 'center', padding: '10px 14px' },
  path: { fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 'var(--text-xs, 12px)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  ellipsis: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badge: { display: 'inline-block', fontSize: 11, lineHeight: '18px', padding: '0 8px', borderRadius: 'var(--radius-pill, 999px)', background: 'var(--bg-surface-3)', color: 'var(--text-muted)', marginLeft: 6 },
  badgeWarn: { background: 'var(--warning)', color: 'var(--bg-body)' },
  beta: { display: 'inline-block', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: '18px', padding: '0 8px', borderRadius: 'var(--radius-pill, 999px)', border: '1px solid var(--border)', color: 'var(--text-bright)' },
  serp: { padding: 16, borderRadius: 'var(--card-radius, 8px)', background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 4 },
  serpUrl: { fontSize: 12, color: 'var(--text-muted)', ...{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
  serpTitle: { fontSize: 18, lineHeight: 1.3, color: 'var(--accent-6, #8ab4f8)' },
  serpDesc: { fontSize: 13, lineHeight: 1.5, color: 'var(--text)' },
  check: { display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10, alignItems: 'start' },
  dot: (done) => ({ width: 20, height: 20, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 700, background: done ? 'var(--success)' : 'var(--bg-surface-3)', color: done ? 'var(--bg-body)' : 'var(--text-muted)' }),
  img: { maxWidth: 360, width: '100%', aspectRatio: '1200 / 630', objectFit: 'cover', borderRadius: 'var(--card-radius, 8px)', border: '1px solid var(--border-subtle)', background: 'var(--bg-surface-2)' }
};

function Counter({ value, ideal, min }) {
  const n = (value || '').length;
  const lo = min || Math.round(ideal * 0.5);
  const tone = !n ? 'var(--text-subtle)' : n > ideal ? 'var(--warning)' : n < lo ? 'var(--warning)' : 'var(--success)';
  const pct = Math.min(100, Math.round((n / ideal) * 100));
  const hint = !n ? 'empty' : n > ideal ? 'too long' : n < lo ? 'short' : 'good';
  return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
    h('div', { style: { flex: '1 1 auto', height: 4, borderRadius: 4, background: 'var(--bg-surface-3)', overflow: 'hidden' } },
      h('div', { style: { width: pct + '%', height: '100%', background: tone, transition: 'width .2s' } })),
    h('span', { style: { fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' } }, `${n} / ${ideal} · ${hint}`));
}

function Section({ title, description, children, aside }) {
  return h(Card, { padding: 20, bordered: true },
    h(Stack, { gap: 16 },
      h(Stack, { direction: 'row', justify: 'between', align: 'start', gap: 12 },
        h(Stack, { gap: 4 }, h(Heading, { level: 3 }, title), description ? h(Text, { variant: 'muted', size: 'sm' }, description) : null),
        aside || null),
      children));
}

function Serp({ url, title, description }) {
  return h('div', { style: css.serp, 'aria-label': 'Search result preview' },
    h('div', { style: css.previewLabel }, 'Google'),
    h('div', { style: css.serpUrl }, url || 'https://example.com/'),
    h('div', { style: css.serpTitle }, title || 'Page title'),
    h('div', { style: css.serpDesc }, description || 'No description yet – search engines will pick text from the page.'));
}

function SocialPreview({ image, domain, title, description }) {
  const host = String(domain || 'example.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return h('div', { style: css.social, 'aria-label': 'Social share preview' },
    h('div', { style: { ...css.previewLabel, padding: '8px 12px 0' } }, 'WhatsApp · LinkedIn · Facebook'),
    image ? h('img', { src: image, alt: '', style: css.socialImg }) : h('div', { style: { ...css.socialImg, display: 'grid', placeItems: 'center', color: 'var(--text-subtle)', fontSize: 12 } }, 'No image'),
    h('div', { style: { padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 3 } },
      h('div', { style: { fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' } }, host),
      h('div', { style: { fontSize: 14, fontWeight: 600, color: 'var(--text-bright)', lineHeight: 1.3 } }, title || 'Page title'),
      h('div', { style: { fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4, maxHeight: 34, overflow: 'hidden' } }, description || '')));
}

function StatusPill({ tone, text }) {
  const color = tone === 'ok' ? 'var(--success)' : tone === 'warn' ? 'var(--warning)' : 'var(--text-subtle)';
  return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' } },
    h('span', { style: { width: 8, height: 8, borderRadius: 99, background: color, flex: '0 0 auto' } }), text);
}

// Media library picker (admin media API)
let mediaCache = null;
function MediaPicker({ onPick, onClose }) {
  const [items, setItems] = useState(mediaCache);
  const [q, setQ] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetchJson('/admin/api/cms/media').then((r) => {
      if (!r.ok) { if (!cancelled && !mediaCache) setItems([]); return; }
      const list = (r.body && r.body.assets ? r.body.assets : []).filter((a) => !a.deletedAt && /^image\//.test(a.mimeType || ''));
      mediaCache = list;
      if (!cancelled) setItems(list);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const shown = (items || []).filter((a) => !q || `${a.filename} ${a.altText || ''}`.toLowerCase().includes(q.toLowerCase()));
  const thumb = (a) => {
    const v = (a.variants || []).find((x) => x.width >= 240) || (a.variants || [])[0];
    return v ? v.path : a.publicPath;
  };
  return h('div', { style: css.overlay, onClick: onClose },
    h('div', { style: css.dialog, onClick: (e) => e.stopPropagation(), role: 'dialog', 'aria-label': 'Choose an image' },
      h(Stack, { direction: 'row', justify: 'between', align: 'center', gap: 12 },
        h(Heading, { level: 3 }, 'Choose an image'),
        h(Button, { variant: 'ghost', onClick: onClose }, 'Close')),
      h(SearchBar, { placeholder: 'Search media', value: q, onChange: setQ }),
      items === null ? h(Text, { variant: 'muted' }, 'Loading media…') :
        !shown.length ? h(EmptyState, { title: 'No images', body: 'Upload images under Media first.' }) :
          h('div', { style: css.mediaGrid }, shown.map((a) => h('button', { key: a.id, type: 'button', style: css.mediaItem, onClick: () => onPick(a), title: a.filename },
            h('img', { src: thumb(a), alt: a.altText || '', style: { width: '100%', aspectRatio: '1 / 1', objectFit: (a.width && a.width < 400) || /logo|favicon|icon|mark|wordmark/i.test(a.filename) ? 'contain' : 'cover', display: 'block', borderRadius: 6, background: 'var(--bg-surface-3)' } }),
            h('div', { style: { fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 4 } }, a.filename),
            a.width ? h('div', { style: { fontSize: 10, color: 'var(--text-subtle)' } }, `${a.width} × ${a.height}`) : null)))));
}

// Image path input with a media library button and a small preview
function ImageField({ label, value, onChange, placeholder, description, onPickAsset, domain }) {
  const [open, setOpen] = useState(false);
  const src = value ? (/^https?:\/\//i.test(value) ? value : (domain || '') + value) : '';
  return h(Stack, { gap: 6 },
    h('div', { style: { display: 'grid', gridTemplateColumns: value ? '56px 1fr auto' : '1fr auto', gap: 8, alignItems: 'end' } },
      value ? h('img', { src: value.startsWith('/') ? value : src, alt: '', style: { width: 56, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-surface-2)' } }) : null,
      h(Input, { label, value: value || '', placeholder, description, onChange: (v) => onChange(v.trim()) }),
      h(Stack, { direction: 'row', gap: 4 },
        h(Button, { variant: 'secondary', onClick: () => setOpen(true) }, 'Choose…'),
        value ? h(Button, { variant: 'ghost', onClick: () => onChange('') }, 'Clear') : null)),
    open ? h(MediaPicker, { onClose: () => setOpen(false), onPick: (a) => { onChange(a.publicPath); if (onPickAsset) onPickAsset(a); setOpen(false); } }) : null);
}

const toLines = (arr) => (Array.isArray(arr) ? arr.join('\n') : arr || '');
const fromLines = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
const absolute = (cfg, p) => (!p ? '' : /^https?:\/\//i.test(p) ? p : cfg.domain ? cfg.domain.replace(/\/+$/, '') + (p.startsWith('/') ? '' : '/') + p : p);

// ------------------------------------------------------------------ tabs

function OverviewTab({ cfg, saved, status, sitemapUrl, go, rows, issuesOf, sync, liveInfo }) {
  const steps = [
    { done: !!(saved.domain && saved.siteName), title: 'Set your domain and site name', body: 'Used for canonical URLs, social previews, schema and the sitemap.', action: () => go('settings', 'general'), label: 'Open settings' },
    { done: !!saved.defaultImage, title: 'Choose a default social image', body: 'Shown when a page is shared on WhatsApp, LinkedIn, Facebook, Slack or X. 1200 × 630 px.', action: () => go('settings', 'social'), label: 'Choose image' },
    { done: !!(status && status.componentSeen), title: 'Add the “Static SEO” component to your layout template', body: 'Site editor → template that wraps every page → Insert → Components → “Static SEO”. Place it once; it renders nothing visible.' },
    { done: !!(status && status.lastPublishSeen), title: 'Publish the site', body: 'Static SEO writes everything during publishing.' }
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const indexable = rows.filter((r) => r.index && !r.noindex).length;
  const hidden = rows.filter((r) => r.noindex).length;
  const toCheck = rows.filter((r) => (issuesOf.get(r.path) || []).length).length;
  const missing = status && !status.componentSeen && status.urlsWithoutComponent && status.urlsWithoutComponent.length;
  const card = (title, value, sub, action) => h(Card, { padding: 16, bordered: true },
    h(Stack, { gap: 6 },
      h(Text, { variant: 'muted', size: 'sm' }, title),
      h('div', { style: { fontSize: 24, fontWeight: 600, color: 'var(--text-bright)', lineHeight: 1.2 } }, value),
      sub ? h(Text, { variant: 'muted', size: 'sm' }, sub) : null,
      action || null));

  return h(Stack, { gap: 16 },
    doneCount < steps.length ? h(Section, { title: `Get started · ${doneCount} of ${steps.length} done`, description: 'A few steps and your site has complete search and social metadata.' },
      h(Stack, { gap: 14 }, steps.map((s, i) => h('div', { key: i, style: css.check },
        h('span', { style: css.dot(s.done) }, s.done ? '✓' : String(i + 1)),
        h(Stack, { gap: 6 }, h(Text, { variant: 'strong' }, s.title), s.done ? null : h(Text, { variant: 'muted', size: 'sm' }, s.body),
          s.action && !s.done ? h('div', null, h(Button, { variant: 'secondary', onClick: s.action }, s.label)) : null))))) : null,
    saved.discourageSearch ? h(Alert, { tone: 'warning', title: 'Staging mode is on' }, 'Search engines are asked not to index any page. Turn it off under Settings → General when the site goes live.') : null,
    missing ? h(Alert, { tone: 'warning', title: 'Component not found on published pages' }, 'Pages were published without the “Static SEO” component, so post entries can’t be identified. Add it to your layout template and publish again.') : null,
    h('div', { style: css.cards },
      card('Search visibility', saved.discourageSearch ? 'Hidden' : 'Visible', saved.discourageSearch ? 'Staging mode – noindex everywhere' : liveInfo || 'Not published yet'),
      card('Indexed pages', String(indexable), `${hidden} hidden from search`, h('div', null, h(Button, { variant: 'ghost', onClick: () => go('pages', 'all') }, 'View pages'))),
      card('Pages to check', String(toCheck), toCheck ? 'Short texts, long titles, missing descriptions …' : 'Nothing to fix right now', toCheck ? h('div', null, h(Button, { variant: 'secondary', onClick: () => go('pages', 'issues') }, 'Review')) : null),
      card('FAQ answers', sync && sync.faqCount !== undefined ? String(sync.faqCount) : '–', sync && sync.faqPages ? `on ${sync.faqPages} pages` : 'Add a FAQ source under Schema', h('div', null, h(Button, { variant: 'ghost', onClick: () => go('schema', 'faq') }, 'FAQ settings')))),
    h(Section, { title: 'Sitemap', description: saved.discourageSearch ? 'Switched off while search engines are discouraged.' : 'Submit this URL in Google Search Console and Bing Webmaster Tools.' },
      sitemapUrl && !saved.discourageSearch && saved.sitemap !== false ? h(Stack, { direction: 'row', gap: 8, align: 'center', wrap: true },
        h('code', { style: { fontSize: 12, color: 'var(--text)', wordBreak: 'break-all', flex: '1 1 300px' } }, sitemapUrl),
        h(Button, { variant: 'secondary', onClick: () => window.open(sitemapUrl, '_blank', 'noopener') }, 'Open'),
        h(Button, { variant: 'ghost', onClick: () => navigator.clipboard && navigator.clipboard.writeText(sitemapUrl) }, 'Copy')) : h(Text, { variant: 'muted', size: 'sm' }, 'No sitemap available.')),
    h(Alert, { tone: 'info', title: 'Using another SEO plugin?' }, 'Disable plugins that also inject og:, twitter: or robots tags, otherwise pages contain duplicates.'));
}

function GeneralTab({ cfg, set }) {
  const localeOptions = (LOCALES.includes(cfg.locale) ? LOCALES : [cfg.locale, ...LOCALES]).map((l) => ({ label: l, value: l }));
  return h(Stack, { gap: 16 },
    h(Section, { title: 'Search engine visibility', description: 'For staging and preview sites that must not appear in search results.' },
      h(Stack, { gap: 12 },
        h(Switch, { label: 'Discourage search engines from indexing this site', description: 'Every page gets noindex, nofollow, canonical links are removed and the sitemap is switched off. Search engines decide themselves whether to honour this.', checked: cfg.discourageSearch, onChange: (v) => set('discourageSearch', v) }),
        cfg.discourageSearch ? h(Alert, { tone: 'warning', title: 'Remember to switch this off before going live' }, 'Otherwise the live site stays out of Google.') : null)),
    h(Section, { title: 'Site', description: 'Basics used on every page.' },
      h('div', { style: css.grid2 },
        h(Input, { label: 'Domain', type: 'url', value: cfg.domain, placeholder: 'https://www.example.com', description: 'Live domain incl. https://, no trailing slash.', onChange: (v) => set('domain', v.trim()) }),
        h(Input, { label: 'Site name', value: cfg.siteName, placeholder: 'Acme Inc.', description: 'Used in titles, og:site_name and schema.', onChange: (v) => set('siteName', v) }),
        h(Input, { label: 'Title separator', value: cfg.titleSeparator, description: `Preview: “About us ${cfg.titleSeparator} ${cfg.siteName || 'Site name'}”`, onChange: (v) => set('titleSeparator', v) }),
        h(Select, { label: 'Language / locale', value: cfg.locale, options: localeOptions, description: 'og:locale and schema inLanguage.', onChange: (v) => set('locale', v) }))),
    h(Section, { title: 'URLs' },
      h(Stack, { gap: 12 },
        h(Switch, { label: 'URLs end with a slash', description: 'Matches Instatic’s default links (/about/).', checked: cfg.trailingSlash, onChange: (v) => set('trailingSlash', v) }),
        h(Switch, { label: 'Output canonical links', description: 'Recommended. Skipped on noindex pages.', checked: cfg.canonical, onChange: (v) => set('canonical', v) }),
        h(Switch, { label: 'Allow large previews in search and AI answers', description: 'Adds max-snippet:-1 and max-image-preview:large to indexable pages, so Google, AI Overviews and assistants may quote longer passages and show big images.', checked: cfg.richPreviews !== false, onChange: (v) => set('richPreviews', v) }))));
}

function SocialTab({ cfg, set }) {
  const img = absolute(cfg, cfg.defaultImage);
  return h(Stack, { gap: 16 },
    h(Section, { title: 'Default social image', description: 'Used when a page has no image of its own. 1200 × 630 px, JPEG or PNG works everywhere.' },
      h('div', { style: css.split },
        h(Stack, { gap: 12 },
          h(ImageField, { label: 'Image', value: cfg.defaultImage, placeholder: '/uploads/…-social.jpg', domain: cfg.domain, onChange: (v) => set('defaultImage', v),
            onPickAsset: (a) => { if (a.width) set('defaultImageWidth', a.width); if (a.height) set('defaultImageHeight', a.height); if (a.altText && !cfg.defaultImageAlt) set('defaultImageAlt', a.altText); } }),
          h('div', { style: css.grid2 },
            h(Input, { label: 'Width (px)', type: 'number', value: String(cfg.defaultImageWidth), onChange: (v) => set('defaultImageWidth', Number(v) || 0) }),
            h(Input, { label: 'Height (px)', type: 'number', value: String(cfg.defaultImageHeight), onChange: (v) => set('defaultImageHeight', Number(v) || 0) })),
          h(Input, { label: 'Alt text', value: cfg.defaultImageAlt, description: 'Describes the image for people using screen readers.', onChange: (v) => set('defaultImageAlt', v) })),
        h(SocialPreview, { image: img, domain: cfg.domain, title: cfg.siteName || 'Your site', description: 'This is how a link to a page without its own image looks when shared.' }))),
    h(Section, { title: 'X (Twitter)' },
      h(Input, { label: 'Account (optional)', value: cfg.twitterSite, placeholder: '@account', onChange: (v) => set('twitterSite', v.trim()) })));
}

function DataBindings({ cfg, set, tables, status, sync }) {
  const [copied, setCopied] = useState(false);
  const [showLive, setShowLive] = useState(false);
  const b = cfg.bindings || { table: '', fields: {} };
  const sources = (tables || []).filter((t) => t.kind === 'data' || t.kind === 'postType');
  const table = sources.find((t) => t.slug === b.table);
  const fieldOptions = [{ label: '— enter manually above —', value: '' }].concat(
    table ? (table.fields || []).filter((f) => !['body', 'pageTree', 'repeater', 'media', 'relation'].includes(f.type) && f.id !== 'body').map((f) => ({ label: `${f.label} (${f.id})`, value: f.id })) : []);
  const mapped = BINDABLE.filter(([k]) => b.fields && b.fields[k]);
  const snippet = mapped.map(([k, , attr]) => `data-sseo-${attr}="{currentEntry.${b.fields[k]}}"`).join('\n');
  const found = status && status.bindings && status.bindings.keys ? status.bindings.keys : [];
  const setTable = (v) => set('bindings', { table: v, fields: {} });
  const setField = (k, v) => set('bindings', { table: b.table, fields: { ...b.fields, [k]: v } });

  return h(Section, { title: 'Use values from your CMS', description: 'Keep company details in one place. Pick the table that holds them and choose a field for each property – that’s all. Static SEO copies the values automatically when you open this workspace, save, or publish from here.' },
    tables === null ? h(Text, { variant: 'muted', size: 'sm' }, 'Loading tables…') : h(Stack, { gap: 12 },
      h(Select, { label: 'Source table', value: b.table, description: 'The first published row is used.', options: [{ label: '— none, enter values manually —', value: '' }].concat(sources.map((t) => ({ label: `${t.name} (${t.kind === 'postType' ? 'post type' : 'data table'})`, value: t.slug }))), onChange: setTable }),
      table ? h('div', { style: css.grid2 }, BINDABLE.map(([k, label]) => h(Select, { key: k, label, value: (b.fields && b.fields[k]) || '', options: fieldOptions, onChange: (v) => setField(k, v) }))) : null,
      mapped.length ? h(Stack, { direction: 'row', gap: 8, align: 'center', wrap: true },
        h(Text, { variant: 'muted', size: 'sm' }, sync && sync.at ? `Last copied ${new Date(sync.at).toLocaleTimeString()}${sync.orgError ? ' – ' + sync.orgError : ''}` : 'Not copied yet – save to apply.'),
        h(Button, { variant: 'ghost', onClick: () => setShowLive(!showLive) }, showLive ? 'Hide advanced' : 'Advanced: always-live values')) : null,
      showLive && mapped.length ? h(Stack, { gap: 8 },
        h(Text, { variant: 'muted', size: 'sm' }, `Optional. Values are normally copied when you work here. If editors change “${table ? table.name : b.table}” and publish from the site editor without opening this workspace, the schema keeps the previous values until the next sync. To read them live on every publish, add these attributes to an element inside a loop over this table (limit 1), e.g. your footer address (site editor → Properties → Attributes).`),
        h('pre', { style: { margin: 0, padding: 12, borderRadius: 'var(--card-radius, 8px)', background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, snippet),
        h(Stack, { direction: 'row', gap: 8, align: 'center' },
          h(Button, { variant: 'secondary', onClick: () => { if (navigator.clipboard) navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 1500); } }, copied ? 'Copied' : 'Copy attributes'),
          found.length ? h(Text, { variant: 'muted', size: 'sm' }, 'Live attributes found on the last publish: ' + found.join(', ')) : null)) : null));
}

function SchemaTab({ cfg, set, setOrg, status, tables, sync, section, setSection }) {
  const org = cfg.org;
  const b = cfg.bindings || { table: '', fields: {} };
  const tableName = ((tables || []).find((t) => t.slug === b.table) || {}).name || b.table;
  const typeOptions = (ORG_TYPES.includes(org.type) ? ORG_TYPES : [org.type, ...ORG_TYPES]).map((t) => ({ label: t, value: t }));
  // Mapped properties show the copied value read-only
  const field = (k, label, props) => {
    const src = b.table && b.fields && b.fields[k];
    const fromData = (cfg.orgFromData || {})[k];
    const usable = Array.isArray(fromData) ? fromData.length > 0 : !!fromData;
    if (src && !usable && sync && sync.at) {
      // Mapped, but the table value was empty or invalid – the manual value is used
      return h(props.multiline ? Textarea : Input, { key: k, label, ...props, multiline: undefined, description: `Value from ${tableName} → ${src} is empty or not usable – this manual value is used.` });
    }
    if (src) {
      const v = fromData;
      return h(Input, { key: k, label, disabled: true, value: Array.isArray(v) ? v.join(' · ') : (v || ''), placeholder: 'Copied on next save or publish', description: `From ${tableName} → ${src}` });
    }
    return h(props.multiline ? Textarea : Input, { key: k, label, ...props, multiline: undefined });
  };
  const parts = [
    h(Section, { title: 'Structured data', description: 'JSON-LD that helps search engines understand your site.' },
      h(Stack, { gap: 12 },
        h(Switch, { label: 'Organization', description: 'Your business, shown on every page.', checked: cfg.schemaOrganization, onChange: (v) => set('schemaOrganization', v) }),
        h(Switch, { label: 'WebSite and WebPage', checked: cfg.schemaWebsite, onChange: (v) => set('schemaWebsite', v) }),
        h(Switch, { label: 'Breadcrumbs', description: 'Built from the URL structure.', checked: cfg.schemaBreadcrumb, onChange: (v) => set('schemaBreadcrumb', v) }))),
    cfg.schemaOrganization ? h(DataBindings, { cfg, set, tables, status, sync }) : null,
    cfg.schemaOrganization ? h(Section, { title: 'Organization', description: b.table ? `Greyed-out fields come from “${tableName}”. Fill in the rest manually or leave it empty.` : 'Leave fields empty that don’t apply.' },
      h(Stack, { gap: 12 },
        h('div', { style: css.grid2 },
          h(Select, { label: 'Type', value: org.type, options: typeOptions, description: 'Pick the most specific schema.org type.', onChange: (v) => setOrg('type', v) }),
          field('name', 'Legal name', { value: org.name, placeholder: cfg.siteName, onChange: (v) => setOrg('name', v) }),
          b.table && b.fields && b.fields.logo ? field('logo', 'Logo (path or URL)', { value: org.logo, onChange: (v) => setOrg('logo', v.trim()) }) : h(ImageField, { label: 'Logo', value: org.logo, domain: cfg.domain, placeholder: '/uploads/…-logo.png', onChange: (v) => setOrg('logo', v) }),
          field('telephone', 'Phone', { value: org.telephone, placeholder: '+49 30 123456', description: 'International format.', onChange: (v) => setOrg('telephone', v) }),
          field('email', 'Email', { type: 'email', value: org.email, onChange: (v) => setOrg('email', v.trim()) })),
        field('description', 'Short description', { multiline: true, rows: 2, value: org.description, onChange: (v) => setOrg('description', v) }),
        h(Separator, null),
        h('div', { style: css.grid2 },
          field('street', 'Street and number', { value: org.street, onChange: (v) => setOrg('street', v) }),
          field('postalCode', 'Postal code', { value: org.postalCode, onChange: (v) => setOrg('postalCode', v) }),
          field('locality', 'City', { value: org.locality, onChange: (v) => setOrg('locality', v) }),
          field('region', 'Region / state', { value: org.region, onChange: (v) => setOrg('region', v) }),
          field('country', 'Country (ISO code)', { value: org.country, placeholder: 'DE', onChange: (v) => setOrg('country', v.trim().toUpperCase()) })),
        field('openingHours', 'Opening hours', { multiline: true, rows: 3, value: toLines(org.openingHours), placeholder: 'Mo-Fr 08:00-17:00\nSa 09:00-12:00', description: 'One block per line, schema.org format.', onChange: (v) => setOrg('openingHours', fromLines(v)) }),
        field('sameAs', 'Profiles (sameAs)', { multiline: true, rows: 3, value: toLines(org.sameAs), placeholder: 'https://www.linkedin.com/company/…', description: 'One URL per line: Google Business Profile, LinkedIn, Instagram …', onChange: (v) => setOrg('sameAs', fromLines(v)) }),
        h(Separator, null),
        h(Text, { variant: 'muted', size: 'sm' }, 'Entity details help search engines and AI assistants understand who you are, where you work and what you know.'),
        h('div', { style: css.grid2 },
          h(Textarea, { label: 'Area served', rows: 3, value: toLines(org.areaServed), placeholder: 'Berlin\nBrandenburg', description: 'One region or city per line.', onChange: (v) => setOrg('areaServed', fromLines(v)) }),
          h(Textarea, { label: 'Expertise (knowsAbout)', rows: 3, value: toLines(org.knowsAbout), placeholder: 'Topic one\nTopic two', description: 'One topic per line.', onChange: (v) => setOrg('knowsAbout', fromLines(v)) })),
        h(Input, { label: 'Founded', value: org.foundingDate, placeholder: '1980 or 1980-04-01', onChange: (v) => setOrg('foundingDate', v.trim()) }))) : null,
    h(FaqSection, { cfg, set, tables, sync })];
  const off = h(Alert, { tone: 'info', title: 'Organization schema is off' }, h(Stack, { gap: 8 }, h(Text, { size: 'sm' }, 'Turn it on to describe your business for search engines and AI assistants.'), h('div', null, h(Button, { variant: 'secondary', onClick: () => set('schemaOrganization', true) }, 'Turn on'))));
  const faq = cfg.faq || {};
  const items = [
    { id: 'organization', label: 'Organization' },
    { id: 'data', label: 'Company data source' },
    { id: 'faq', label: 'FAQ', count: faq.enabled === false ? 'off' : sync && sync.faqCount !== undefined ? sync.faqCount : undefined },
    { id: 'output', label: 'Output' }
  ];
  const active = section || 'organization';
  return h(SideLayout, { items, active, onSelect: setSection, label: 'Schema sections' },
    active === 'output' ? parts[0] : active === 'data' ? (parts[1] || off) : active === 'faq' ? parts[3] : (parts[2] || off));
}

function FaqSection({ cfg, set, tables, sync }) {
  const faq = cfg.faq || { enabled: true, sources: [] };
  const sources = faq.sources || [];
  const setFaq = (patch) => set('faq', { ...faq, ...patch });
  const setSource = (i, patch) => setFaq({ sources: sources.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const removeSource = (i) => setFaq({ sources: sources.filter((_, j) => j !== i) });
  const addSource = () => setFaq({ sources: [...sources, { type: 'repeater', table: '', field: '', question: '', answer: '', enabled: true }] });
  const all = tables || [];
  const opt = (f) => ({ label: `${f.label} (${f.id})`, value: f.id });
  const textish = (f) => ['text', 'longText', 'richText'].includes(f.type);

  return h(Section, { title: 'FAQ (FAQPage)', description: 'Questions and answers stay where you maintain them – in a repeater of a post type or in a data table. Static SEO turns them into FAQPage schema for the matching pages. Answer engines and AI assistants use this markup to quote your answers.' },
    h(Stack, { gap: 12 },
      h(Switch, { label: 'Output FAQPage schema', description: 'Turn off if your site already adds FAQ schema itself (e.g. with a script), to avoid duplicates.', checked: faq.enabled !== false, onChange: (v) => setFaq({ enabled: v }) }),
      faq.enabled !== false ? h(Stack, { gap: 12 },
        sources.map((s, i) => {
          const isRep = s.type !== 'table';
          const candidates = all.filter((t) => (isRep ? (t.fields || []).some((f) => f.type === 'repeater') : t.kind === 'data'));
          const t = all.find((x) => x.slug === s.table);
          const rep = isRep && t ? (t.fields || []).find((f) => f.id === s.field) : null;
          const qaFields = isRep ? (rep && rep.fields ? rep.fields.filter(textish) : []) : (t ? (t.fields || []).filter(textish) : []);
          return h(Card, { key: i, padding: 16, bordered: true },
            h(Stack, { gap: 12 },
              h(Stack, { direction: 'row', justify: 'between', align: 'center' },
                h(Text, { variant: 'strong' }, `Source ${i + 1}`),
                h(Stack, { direction: 'row', gap: 8, align: 'center' },
                  h(Switch, { label: 'Active', checked: s.enabled !== false, onChange: (v) => setSource(i, { enabled: v }) }),
                  h(Button, { variant: 'ghost', onClick: () => removeSource(i) }, 'Remove'))),
              h('div', { style: css.grid2 },
                h(Select, { label: 'Type', value: isRep ? 'repeater' : 'table', options: [{ label: 'Repeater field of a post type', value: 'repeater' }, { label: 'Rows of a data table', value: 'table' }], onChange: (v) => setSource(i, { type: v, table: '', field: '', question: '', answer: '', pathField: '', paths: [] }) }),
                h(Select, { label: isRep ? 'Post type' : 'Table', value: s.table || '', options: [{ label: '— choose —', value: '' }].concat(candidates.map((x) => ({ label: x.name, value: x.slug }))), onChange: (v) => setSource(i, { table: v, field: '', question: '', answer: '' }) }),
                isRep && t ? h(Select, { label: 'Repeater field', value: s.field || '', options: [{ label: '— choose —', value: '' }].concat((t.fields || []).filter((f) => f.type === 'repeater').map(opt)), onChange: (v) => setSource(i, { field: v, question: '', answer: '' }) }) : null),
              qaFields.length ? h('div', { style: css.grid2 },
                h(Select, { label: 'Question', value: s.question || '', options: [{ label: '— choose —', value: '' }].concat(qaFields.map(opt)), onChange: (v) => setSource(i, { question: v }) }),
                h(Select, { label: 'Answer', value: s.answer || '', options: [{ label: '— choose —', value: '' }].concat(qaFields.map(opt)), onChange: (v) => setSource(i, { answer: v }) })) : null,
              !isRep && t ? h(Stack, { gap: 8 },
                h(Select, { label: 'Show on', value: s.pathField ? 'field' : 'paths', options: [{ label: 'Fixed pages', value: 'paths' }, { label: 'Page given in a field of each row', value: 'field' }], onChange: (v) => setSource(i, v === 'field' ? { pathField: ((t.fields || []).find(textish) || {}).id || '' } : { pathField: '' }) }),
                s.pathField
                  ? h(Select, { label: 'Field with the page path', value: s.pathField, description: 'e.g. /contact/ – several paths separated by commas or new lines.', options: (t.fields || []).filter(textish).map(opt), onChange: (v) => setSource(i, { pathField: v }) })
                  : h(Textarea, { label: 'Pages', rows: 2, value: toLines(s.paths), placeholder: '/faq/\n/contact/', description: 'One path per line. All questions of the table appear on these pages.', onChange: (v) => setSource(i, { paths: fromLines(v) }) })) : null,
              isRep && t && s.field ? h(Text, { variant: 'muted', size: 'sm' }, `Each ${t.singularLabel || 'entry'} gets FAQ schema from its own “${rep ? rep.label : s.field}” rows on ${t.routeBase || '/' + t.slug}/….`) : null));
        }),
        h(Stack, { direction: 'row', gap: 8, align: 'center' },
          h(Button, { variant: 'secondary', onClick: addSource }, 'Add FAQ source'),
          sync && sync.faqPages !== undefined ? h(Text, { variant: 'muted', size: 'sm' }, `Last copy: ${sync.faqCount} questions on ${sync.faqPages} pages.`) : null)) : null));
}

const SCHEMA_TYPES = [
  { value: 'WebPage', label: 'WebPage (default)' },
  { value: 'Service', label: 'Service' },
  { value: 'Article', label: 'Article' },
  { value: 'BlogPosting', label: 'BlogPosting' },
  { value: 'NewsArticle', label: 'NewsArticle' },
  { value: 'Product', label: 'Product' }
];

function ContentTypesTab({ cfg, set, tables, rowsByTable, sync, active, setActive }) {
  const postTypes = (tables || []).filter((t) => t.kind === 'postType');
  if (tables === null) return h(Text, { variant: 'muted' }, 'Loading post types…');
  if (!postTypes.length) return h(EmptyState, { title: 'No post types', body: 'This site has no post types yet. Pages are configured under Pages and in the site editor’s SEO panel.' });
  const pts = cfg.postTypes || {};
  const update = (slug, t, patch) => {
    const next = { routeBase: t.routeBase, label: t.name, index: true, sitemap: true, schemaType: 'WebPage', titlePattern: '', descriptionField: '', noindexField: '', noindexOp: '!=', noindexValue: '', ...(pts[slug] || {}), ...patch };
    const f = (t.fields || []).find((x) => x.id === next.noindexField);
    if (f && f.type === 'boolean' && !next.noindexValue) next.noindexValue = 'true';
    set('postTypes', { ...pts, [slug]: next });
  };

  const current = postTypes.find((t) => t.slug === active) || postTypes[0];
  const sideItems = postTypes.map((t) => ({ id: t.slug, label: t.name, count: (rowsByTable && rowsByTable[t.slug] ? rowsByTable[t.slug].length : undefined) }));
  return h(SideLayout, { items: sideItems, active: current.slug, onSelect: setActive, label: 'Post types' }, h(Stack, { gap: 16 },
    h(Alert, { tone: 'info', title: 'Rules for all entries of a post type' }, 'Per-entry SEO title and description are edited in the Content workspace (right sidebar). Per-URL exceptions go under Pages. Field values used below are copied automatically when you save or publish from here.'),
    [current].map((t) => {
      const c = { index: true, sitemap: true, schemaType: 'WebPage', titlePattern: '', descriptionField: '', noindexField: '', noindexOp: '!=', noindexValue: '', ...(pts[t.slug] || {}) };
      const rows = (rowsByTable && rowsByTable[t.slug]) || [];
      const fields = (t.fields || []).filter((f) => !['body', 'pageTree', 'repeater', 'media', 'relation', 'multiSelect'].includes(f.type) && !['title', 'slug', 'body', 'seoTitle', 'seoDescription', 'featuredMedia'].includes(f.id));
      const textFields = fields.filter((f) => ['text', 'longText', 'richText'].includes(f.type));
      const ruleField = fields.find((f) => f.id === c.noindexField);
      const sample = rows[0] && rows[0].cells && rows[0].cells.title ? String(rows[0].cells.title) : 'Entry title';
      const fillMap = { title: sample, site: cfg.siteName || 'Site name', sep: cfg.titleSeparator };
      const preview = (c.titlePattern || '{title} {sep} {site}').replace(/\{(title|site|sep)\}/g, (all, key) => fillMap[key]);
      if (ruleField && ruleField.type === 'boolean' && !c.noindexValue) c.noindexValue = 'true';
      const hidden = c.noindexField ? rows.filter((r) => ruleMatches(c, r.cells)).length : 0;
      return h(Section, { key: t.slug, title: `${t.name}`, description: `${t.routeBase || '/' + t.slug}/… · ${rows.length} published ${rows.length === 1 ? 'entry' : 'entries'}` },
        h(Stack, { gap: 12 },
          h('div', { style: css.grid2 },
            h(Switch, { label: 'Show in search results', description: 'Off = all entries get noindex.', checked: c.index !== false, onChange: (v) => update(t.slug, t, { index: v }) }),
            h(Switch, { label: 'Include in sitemap', checked: c.sitemap !== false && c.index !== false, disabled: c.index === false, onChange: (v) => update(t.slug, t, { sitemap: v }) })),
          h(Stack, { gap: 4 },
            h(Input, { label: 'Title pattern', value: c.titlePattern, placeholder: '{title} {sep} {site}', description: 'Used when an entry has no SEO title. Placeholders: {title}, {sep}, {site}.', onChange: (v) => update(t.slug, t, { titlePattern: v }) }),
            h(Text, { variant: 'muted', size: 'sm' }, 'Preview: ' + preview)),
          h('div', { style: css.grid2 },
            h(Select, { label: 'Schema type', value: c.schemaType, options: SCHEMA_TYPES, description: 'Article types add dates and author automatically.', onChange: (v) => update(t.slug, t, { schemaType: v }) }),
            h(Select, { label: 'Fallback description field', value: c.descriptionField, options: [{ label: '— none (site default) —', value: '' }].concat(textFields.map((f) => ({ label: `${f.label} (${f.id})`, value: f.id }))), description: 'Used when SEO description is empty.', onChange: (v) => update(t.slug, t, { descriptionField: v }) })),
          c.index !== false ? h(Stack, { gap: 8 },
            h(Text, { variant: 'strong', size: 'sm' }, 'Hide entries by field (optional)'),
            h('div', { style: css.grid2 },
              h(Select, { label: 'Field', value: c.noindexField, options: [{ label: '— no rule —', value: '' }].concat(fields.map((f) => ({ label: `${f.label} (${f.id})`, value: f.id }))), onChange: (v) => update(t.slug, t, { noindexField: v, noindexValue: ((fields.find((f) => f.id === v) || {}).type === 'boolean') ? 'true' : '' }) }),
              c.noindexField ? h(Select, { label: 'Condition', value: c.noindexOp, options: [{ label: 'is not', value: '!=' }, { label: 'is', value: '=' }], onChange: (v) => update(t.slug, t, { noindexOp: v }) }) : null,
              c.noindexField ? (ruleField && ruleField.type === 'boolean'
                ? h(Select, { label: 'Value', value: c.noindexValue || 'true', options: [{ label: 'on (true)', value: 'true' }, { label: 'off (false)', value: 'false' }], onChange: (v) => update(t.slug, t, { noindexValue: v }) })
                : ruleField && ruleField.options
                  ? h(Select, { label: 'Value', value: c.noindexValue, options: [{ label: '(empty)', value: '' }].concat(ruleField.options.map((o) => ({ label: o.label, value: o.value }))), onChange: (v) => update(t.slug, t, { noindexValue: v }) })
                  : h(Input, { label: 'Value', value: c.noindexValue, onChange: (v) => update(t.slug, t, { noindexValue: v }) })) : null),
            c.noindexField ? h(Text, { variant: 'muted', size: 'sm' }, `Entries where “${ruleField ? ruleField.label : c.noindexField}” ${c.noindexOp === '=' ? 'is' : 'is not'} ${c.noindexValue || (ruleField && ruleField.type === 'boolean' ? 'true' : '(empty)')} get noindex – currently ${hidden} of ${rows.length}.`) : null) : null));
    }),
    sync && sync.at ? h(Text, { variant: 'muted', size: 'sm' }, `Entry data copied ${new Date(sync.at).toLocaleTimeString()} · ${sync.entries} entries`) : null));
}

// Readable issues from the audit facts recorded on publish
function parseAudit(d) {
  try { return JSON.parse((d && d.audit) || '{}') || {}; } catch (e) { return {}; }
}

function pageIssues(row, dupTitles) {
  if (!row.index || row.noindex) return [];
  const a = row.audit || {};
  if (!Object.keys(a).length) return [];
  const out = [];
  if (a.titleLength > 60) out.push(`Title is long (${a.titleLength} characters) – may be cut off in results.`);
  else if (a.titleLength && a.titleLength < 25) out.push(`Title is short (${a.titleLength} characters).`);
  if (dupTitles && dupTitles.has(row.title)) out.push('Same title as another page.');
  if (a.descSource === 'site' || a.descSource === 'none') out.push('No own description – the site default is used.');
  else if (a.descLength && a.descLength < 70) out.push(`Description is short (${a.descLength} characters).`);
  if (a.h1 === 0) out.push('No H1 heading.');
  else if (a.h1 > 1) out.push(`${a.h1} H1 headings – use one.`);
  if (a.missingAlt) out.push(`${a.missingAlt} image${a.missingAlt > 1 ? 's' : ''} without alt attribute.`);
  if (a.words < 150) out.push(`Little text (${a.words} words) – answer engines prefer pages that answer a question fully.`);
  return out;
}

function PageEditor({ cfg, row, onSave, onReset, onCancel, busy, issues }) {
  const ov = row.override || {};
  const [title, setTitle] = useState(ov.title || '');
  const [description, setDescription] = useState(ov.description || '');
  const [image, setImage] = useState(ov.image || '');
  const [noindex, setNoindex] = useState(!!ov.noindex);
  const fallbackTitle = row.index ? row.index.title : '';
  const shownTitle = title || fallbackTitle;
  const img = absolute(cfg, image || cfg.defaultImage);
  return h('div', { style: { padding: 16, background: 'var(--bg-surface-2)', borderTop: '1px solid var(--border-subtle)' } },
    h(Stack, { gap: 16 },
      issues && issues.length ? h(Alert, { tone: 'warning', title: 'Found on the last publish' }, h('ul', { style: { margin: 0, paddingLeft: 18 } }, issues.map((t, i) => h('li', { key: i }, t)))) : null,
      h('div', { style: css.split },
        h(Stack, { gap: 14 },
          h(Stack, { gap: 6 }, h(Input, { label: 'SEO title', value: title, placeholder: fallbackTitle || 'Uses the page title pattern', onChange: setTitle }), h(Counter, { value: shownTitle, ideal: 60, min: 30 })),
          h(Stack, { gap: 6 }, h(Textarea, { label: 'Meta description', rows: 3, value: description, placeholder: 'Uses the entry’s SEO description or the site default', onChange: setDescription }), h(Counter, { value: description, ideal: 155, min: 70 })),
          h(ImageField, { label: 'Social image', value: image, placeholder: 'Uses the entry image or the default social image', domain: cfg.domain, onChange: setImage }),
          h(Switch, { label: 'Hide from search engines (noindex)', description: 'Also removes the page from the sitemap.', checked: noindex, onChange: setNoindex })),
        h(Stack, { gap: 12 },
          h(Serp, { url: (cfg.domain || '') + row.path, title: shownTitle, description }),
          h(SocialPreview, { image: img, domain: cfg.domain, title: shownTitle, description }))),
      h(Stack, { direction: 'row', gap: 8 },
        h(Button, { variant: 'primary', disabled: busy, onClick: () => onSave({ path: row.path, title: title.trim(), description: description.trim(), image, noindex }) }, 'Save page'),
        row.override ? h(Button, { variant: 'ghost', disabled: busy, onClick: onReset }, 'Reset to defaults') : null,
        h(Button, { variant: 'ghost', disabled: busy, onClick: onCancel }, 'Cancel'))));
}

function PagesTab({ cfg, rows, api, reload, setNotice, issuesOf, filter, setFilter }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newPath, setNewPath] = useState('');
  const counts = {
    all: rows.length,
    pages: rows.filter((r) => !r.index || r.index.kind !== 'entry').length,
    entries: rows.filter((r) => r.index && r.index.kind === 'entry').length,
    hidden: rows.filter((r) => r.noindex).length,
    issues: rows.filter((r) => (issuesOf.get(r.path) || []).length).length
  };
  const byFilter = (r) => filter === 'pages' ? (!r.index || r.index.kind !== 'entry')
    : filter === 'entries' ? (r.index && r.index.kind === 'entry')
      : filter === 'hidden' ? r.noindex
        : filter === 'issues' ? (issuesOf.get(r.path) || []).length > 0 : true;
  const shown = rows.filter((r) => byFilter(r) && (!query || (r.path + ' ' + (r.title || '')).toLowerCase().includes(query.toLowerCase())));

  async function save(data) {
    setBusy(true);
    try {
      const row = rows.find((r) => r.path === data.path);
      const clean = { path: data.path, noindex: !!data.noindex };
      if (data.title) clean.title = data.title;
      if (data.description) clean.description = data.description;
      if (data.image) clean.image = data.image;
      if (row && row.override) await api.update('pages', row.overrideId, clean); else await api.create('pages', clean);
      setOpen(null); setNotice('Saved. Publish the site to apply.'); await reload();
    } catch (e) { setNotice('Error: ' + e.message); } finally { setBusy(false); }
  }
  async function reset(row) {
    setBusy(true);
    try { await api.remove('pages', row.overrideId); setOpen(null); setNotice('Reset. Publish the site to apply.'); await reload(); }
    catch (e) { setNotice('Error: ' + e.message); } finally { setBusy(false); }
  }
  async function forget(row) {
    setBusy(true);
    try { await api.remove('index', row.indexId); setNotice('Removed from the URL list and sitemap.'); await reload(); }
    catch (e) { setNotice('Error: ' + e.message); } finally { setBusy(false); }
  }
  function addPath() {
    let p = newPath.trim();
    if (!p) return;
    if (!p.startsWith('/')) p = '/' + p;
    if (cfg.trailingSlash && !p.endsWith('/') && !/\.[a-z0-9]{2,5}$/i.test(p)) p += '/';
    setNewPath(''); setOpen(p);
  }
  const descOf = (r) => {
    const a = r.audit || {};
    if (r.override && r.override.description) return 'Custom description';
    return { page: 'Custom description', binding: 'From page data', entry: 'From entry SEO field', fallback: 'From fallback field', site: 'Site default description', none: 'No description' }[a.descSource] || '';
  };
  const openRow = open && (rows.find((r) => r.path === open) || { path: open });

  const sideItems = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'pages', label: 'Pages', count: counts.pages },
    { id: 'entries', label: 'Entries', count: counts.entries },
    { id: 'hidden', label: 'Hidden from search', count: counts.hidden },
    { id: 'issues', label: 'To check', count: counts.issues, warn: counts.issues > 0 }
  ];
  return h(SideLayout, { items: sideItems, active: filter, onSelect: setFilter, label: 'Page filters' }, h(Stack, { gap: 12 },
    h(Stack, { direction: 'row', gap: 8, align: 'end', wrap: true },
      h('div', { style: { flex: '1 1 260px' } }, h(SearchBar, { placeholder: 'Search by path or title', value: query, onChange: setQuery })),
      h('div', { style: { flex: '0 1 220px' } }, h(Input, { placeholder: '/path-not-listed-yet/', value: newPath, onChange: setNewPath })),
      h(Button, { variant: 'secondary', onClick: addPath }, 'Add URL')),
    rows.length === 0 && !openRow ? h(EmptyState, { title: 'No pages yet', body: 'Publish the site once – every published URL appears here.' }) :
      h('div', { style: { border: '1px solid var(--border-subtle)', borderRadius: 'var(--card-radius, 8px)', overflow: 'hidden' } },
        openRow && !rows.find((r) => r.path === open) ? h(PageEditor, { key: 'new-' + open, cfg, row: openRow, busy, onSave: save, onCancel: () => setOpen(null) }) : null,
        !shown.length ? h('div', { style: { padding: 24 } }, h(Text, { variant: 'muted' }, 'No pages match this filter.')) : null,
        shown.map((r, i) => {
          const issues = issuesOf.get(r.path) || [];
          const tone = r.noindex ? 'off' : issues.length ? 'warn' : 'ok';
          return h('div', { key: r.path, style: i ? { borderTop: '1px solid var(--border-subtle)' } : null },
            h('div', { style: { ...css.row, cursor: 'pointer' }, onClick: () => setOpen(open === r.path ? null : r.path) },
              h(StatusPill, { tone, text: '' }),
              h('div', { style: { minWidth: 0 } },
                h('div', { style: { ...css.ellipsis, fontSize: 14, color: 'var(--text-bright)' }, title: r.title }, r.title || r.path),
                h('div', { style: { ...css.ellipsis, display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 } },
                  h('span', { style: css.path }, r.path),
                  h('span', { style: { fontSize: 11, color: 'var(--text-subtle)' } }, descOf(r)))),
              h('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } },
                r.index && r.index.kind === 'entry' ? h('span', { style: css.badge }, 'entry') : null,
                r.override ? h('span', { style: css.badge }, 'custom') : null,
                r.noindex ? h('span', { style: css.badge }, 'hidden') : null,
                issues.length ? h('span', { style: { ...css.badge, ...css.badgeWarn }, title: issues.join('\n') }, `${issues.length} to check`) : null,
                r.stale ? h('span', { style: css.badge, title: 'Not published for 30+ days' }, 'stale') : null,
                r.stale && r.indexId ? h(Button, { variant: 'ghost', disabled: busy, onClick: (e) => { e.stopPropagation(); forget(r); } }, 'Remove') : null,
                h(Button, { variant: 'ghost', onClick: (e) => { e.stopPropagation(); setOpen(open === r.path ? null : r.path); } }, open === r.path ? 'Close' : 'Edit'))),
            open === r.path ? h(PageEditor, { key: 'ed-' + r.path, cfg, row: r, issues, busy, onSave: save, onReset: () => reset(r), onCancel: () => setOpen(null) }) : null);
        }))));
}

// Same sub-navigation on every tab: sidebar on the left, content on the right
function SideLayout({ items, active, onSelect, label, children }) {
  return h('div', { style: css.settingsGrid },
    h('nav', { style: css.subnav, 'aria-label': label || 'Sections' }, items.map((it) => h('button', {
      key: it.id, type: 'button', onClick: () => onSelect(it.id),
      style: { ...css.subnavItem, ...(active === it.id ? css.subnavActive : {}), display: 'flex', justifyContent: 'space-between', gap: 8 },
      'aria-current': active === it.id ? 'page' : undefined
    }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.label),
      it.count !== undefined ? h('span', { style: { color: it.warn ? 'var(--warning)' : 'var(--text-subtle)', fontSize: 12 } }, String(it.count)) : null))),
    h('div', { style: { minWidth: 0 } }, children));
}

function SettingsTab({ section, setSection, cfg, set, saved, sitemapUrl, backupProps }) {
  const items = [{ id: 'general', label: 'General' }, { id: 'social', label: 'Social' }, { id: 'indexing', label: 'Indexing & sitemap' }, { id: 'backup', label: 'Import / export' }];
  return h(SideLayout, { items, active: section, onSelect: setSection, label: 'Settings sections' },
    section === 'social' ? h(SocialTab, { cfg, set })
      : section === 'indexing' ? h(IndexingTab, { cfg, set, sitemapUrl })
        : section === 'backup' ? h(BackupTab, backupProps)
          : h(GeneralTab, { cfg, set }));
}

function IndexingTab({ cfg, set, sitemapUrl }) {
  return h(Stack, { gap: 16 },
    h(Section, { title: 'Hide from search engines', description: 'Pages matching these paths get noindex and are left out of the sitemap. One path per line; end with * to match everything below.' },
      h(Textarea, { label: 'noindex paths', rows: 5, value: toLines(cfg.noindexPaths), placeholder: '/imprint/\n/privacy/\n/drafts/*', onChange: (v) => set('noindexPaths', fromLines(v)) })),
    h(Section, { title: 'XML sitemap', description: 'Lists every published, indexable URL.' },
      h(Stack, { gap: 12 },
        h(Switch, { label: 'Provide a sitemap', checked: cfg.sitemap, onChange: (v) => set('sitemap', v) }),
        cfg.sitemap ? h(Stack, { gap: 8 },
          h(Text, { variant: 'mono', size: 'sm' }, sitemapUrl || 'Set your domain first'),
          sitemapUrl ? h(Stack, { direction: 'row', gap: 8 },
            h(Button, { variant: 'secondary', onClick: () => window.open(sitemapUrl, '_blank', 'noopener') }, 'Open sitemap'),
            h(Button, { variant: 'ghost', onClick: () => navigator.clipboard && navigator.clipboard.writeText(sitemapUrl) }, 'Copy URL')) : null,
          h(Text, { variant: 'muted', size: 'sm' }, 'Instatic serves plugin routes below /admin/api/…. Submit this URL directly in Google Search Console, or forward /sitemap.xml to it (for example with a Cloudflare redirect rule).')) : null)));
}

function BackupTab({ pluginId, version, saved, overrides, api, configId, reload, setNotice }) {
  const [pending, setPending] = useState(null);
  const [mode, setMode] = useState('replace');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function exportJson() {
    const data = {
      format: 'static-seo-backup', plugin: pluginId, pluginVersion: version, exportedAt: new Date().toISOString(),
      site: saved.domain || '', settings: saved,
      pages: overrides.map((r) => r.data).filter((d) => d && d.path)
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const host = (saved.domain || 'site').replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '-');
    a.href = url;
    a.download = `static-seo-${host}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function pickFile(e) {
    setError(''); setPending(null);
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.format !== 'static-seo-backup' || typeof data.settings !== 'object') throw new Error('This file is not a Static SEO backup.');
      const pages = Array.isArray(data.pages) ? data.pages.filter((p) => p && typeof p.path === 'string' && /^\/[^\s<>"]*$/.test(p.path) && p.path.length <= 500) : [];
      setPending({ name: file.name, data, pages });
    } catch (err) { setError(err.message || 'Could not read the file.'); }
  }

  async function apply() {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const settings = mergeDefaults(DEFAULTS, pending.data.settings);
      const cfgData = { key: 'main', json: JSON.stringify(settings) };
      if (configId) await api.update('config', configId, cfgData); else await api.create('config', cfgData);
      const byPath = new Map(overrides.map((r) => [r.data && r.data.path, r]));
      if (mode === 'replace') {
        await runLimited(overrides.map((r) => () => api.remove('pages', r.id)));
        byPath.clear();
      }
      const jobs = [];
      for (const p of pending.pages) {
        const clean = { path: p.path, noindex: p.noindex === true || p.noindex === 'true' };
        if (typeof p.title === 'string' && p.title.trim()) clean.title = p.title.trim().slice(0, 300);
        if (typeof p.description === 'string' && p.description.trim()) clean.description = p.description.trim().slice(0, 1000);
        if (typeof p.image === 'string' && p.image.trim()) clean.image = p.image.trim().slice(0, 1000);
        const existing = byPath.get(p.path);
        jobs.push(() => (existing ? api.update('pages', existing.id, clean) : api.create('pages', clean)));
      }
      await runLimited(jobs);
      setPending(null);
      setNotice(`Imported settings and ${pending.pages.length} page entries. Publish the site to apply.`);
      await reload();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const differentSite = pending && pending.data.site && saved.domain && pending.data.site !== saved.domain;
  return h(Stack, { gap: 16 },
    h(Section, { title: 'Export', description: 'Downloads all settings and per-page entries as a JSON file. Keep it before uninstalling the plugin – uninstalling deletes its data.' },
      h(Stack, { direction: 'row', gap: 8, align: 'center' },
        h(Button, { variant: 'secondary', onClick: exportJson }, 'Download backup'),
        h(Text, { variant: 'muted', size: 'sm' }, `${overrides.length} page entries · saved settings only`))),
    h(Section, { title: 'Import', description: 'Restores a backup or copies the setup from another site. The list of published URLs is rebuilt on the next publish.' },
      h(Stack, { gap: 12 },
        h('input', { type: 'file', accept: 'application/json,.json', onChange: pickFile, style: { color: 'var(--text-muted)', fontSize: 13 } }),
        error ? h(Alert, { tone: 'danger' }, error) : null,
        pending ? h(Stack, { gap: 12 },
          h(Alert, { tone: differentSite ? 'warning' : 'info', title: pending.name },
            `Backup from ${pending.data.site || 'an unknown site'}, ${pending.data.exportedAt ? pending.data.exportedAt.slice(0, 10) : 'unknown date'} · ${pending.pages.length} page entries.` +
            (differentSite ? ` The domain differs from this site (${saved.domain}) – check General after importing.` : '')),
          h(Select, { label: 'Page entries', value: mode, options: [{ label: 'Replace all current page entries', value: 'replace' }, { label: 'Merge – update matching paths, keep the rest', value: 'merge' }], onChange: setMode }),
          h(Stack, { direction: 'row', gap: 8 },
            h(Button, { variant: 'primary', disabled: busy, onClick: apply }, busy ? 'Importing…' : 'Import'),
            h(Button, { variant: 'ghost', disabled: busy, onClick: () => setPending(null) }, 'Cancel'))) : null)));
}

// Instatic doesn't mark plugin pages as active in the top navigation – do it for our own link
function useActiveNavLink(href) {
  useEffect(() => {
    let link = null;
    let prev = null;
    const mark = () => {
      const esc = window.CSS && CSS.escape ? CSS.escape(href) : String(href).replace(/["\\]/g, '\\$&');
      link = document.querySelector(`a[href="${esc}"]`);
      if (!link) return false;
      prev = { color: link.style.color, current: link.getAttribute('aria-current') };
      link.style.color = 'var(--text-bright, rgb(237, 237, 237))';
      link.setAttribute('aria-current', 'page');
      return true;
    };
    const timer = mark() ? null : setTimeout(mark, 300);
    return () => {
      if (timer) clearTimeout(timer);
      if (link && prev) {
        link.style.color = prev.color;
        if (prev.current === null) link.removeAttribute('aria-current'); else link.setAttribute('aria-current', prev.current);
      }
    };
  }, [href]);
}

// ------------------------------------------------------------------ app

function PublishBar({ busy, ask, mfa, error, onPublish, onConfirm, onCancel, live }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => { if (!ask) { setPassword(''); setCode(''); } }, [ask]);
  if (!ask) {
    return h(Stack, { direction: 'row', gap: 8, align: 'center' },
      live ? h(Text, { variant: 'muted', size: 'sm' }, live) : null,
      h(Button, { variant: 'primary', disabled: busy, onClick: onPublish }, busy ? 'Publishing…' : 'Publish site'));
  }
  return h(Card, { padding: 16, bordered: true },
    h(Stack, { gap: 12 },
      h(Text, { variant: 'strong' }, 'Confirm with your password'),
      h(Text, { variant: 'muted', size: 'sm' }, 'Instatic asks for your password before publishing. It is sent only to Instatic’s own sign-in check and is not stored. The confirmation stays valid for a few minutes.'),
      h('form', { onSubmit: (e) => { e.preventDefault(); onConfirm(password, code); } },
        h(Stack, { gap: 12 },
          h(Input, { label: 'Password', type: 'password', autoComplete: 'current-password', value: password, onChange: setPassword }),
          mfa ? h(Input, { label: 'Authentication code', autoComplete: 'one-time-code', inputMode: 'numeric', value: code, onChange: setCode }) : null,
          error ? h(Alert, { tone: 'danger' }, error) : null,
          h(Stack, { direction: 'row', gap: 8 },
            h(Button, { variant: 'primary', type: 'submit', disabled: busy || !password }, busy ? 'Publishing…' : 'Confirm and publish'),
            h(Button, { variant: 'ghost', disabled: busy, onClick: onCancel }, 'Cancel'))))));
}

export default function StaticSeoApp({ page }) {
  const pluginId = page && page.pluginId ? page.pluginId : 'staticseo.core';
  const api = useMemo(() => recordsApi(pluginId), [pluginId]);
  const routes = usePluginRoutes();
  const routesRef = useRef(routes);
  routesRef.current = routes;

  const [tab, setTab] = useState('overview');
  const [settingsSection, setSettingsSection] = useState('general');
  const [pagesFilter, setPagesFilter] = useState('all');
  const [typeActive, setTypeActive] = useState('');
  const [schemaSection, setSchemaSection] = useState('organization');
  const [cfg, setCfg] = useState(DEFAULTS);
  const [saved, setSaved] = useState(DEFAULTS);
  const [configId, setConfigId] = useState(null);
  const [overrides, setOverrides] = useState([]);
  const [index, setIndex] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [tables, setTables] = useState(null);
  const [rowsByTable, setRowsByTable] = useState({});
  const [sync, setSync] = useState(null);
  const [pub, setPub] = useState({ busy: false, ask: false, mfa: false, error: '' });
  const [pubStatus, setPubStatus] = useState(null);
  const [lastChange, setLastChange] = useState('');

  const go = (t, sub) => {
    setTab(t);
    if (t === 'settings' && sub) setSettingsSection(sub);
    if (t === 'pages' && sub) setPagesFilter(sub);
    if (t === 'schema' && sub) setSchemaSection(sub);
  };

  const loadCms = useCallback(async (conf) => {
    const t = await listTables();
    const faqTables = ((conf.faq && conf.faq.sources) || []).map((s) => s.table);
    const wanted = t.filter((x) => x.kind === 'postType' || x.slug === 'pages' || (conf.bindings && x.slug === conf.bindings.table) || faqTables.includes(x.slug));
    const rb = {};
    await Promise.all(wanted.map(async (x) => { rb[x.slug] = await listPublishedRows(x); }));
    setTables(t); setRowsByTable(rb);
    return { t, rb };
  }, []);

  // Syncs run one after another and always with the latest saved settings: a sync started
  // when the page opened must not finish after a save and act on the old rules
  const syncChain = useRef(Promise.resolve());
  const latestConf = useRef(null);
  const doSync = useCallback(async (cId, index, lastPublishedAt) => {
    try {
      const conf = latestConf.current || DEFAULTS;
      const { t, rb } = await loadCms(conf);
      const res = await syncCmsData({ api, saved: conf, configId: cId, tables: t, rowsByTable: rb, index, lastPublishedAt });
      setSync(res);
      if (res.pruned && res.pruned.length) setIndex((list) => list.filter((r) => !res.pruned.includes(r.id)));
      const ofd = res.orgFromData || {};
      setSaved((s) => ({ ...s, orgFromData: ofd }));
      setCfg((c) => ({ ...c, orgFromData: ofd }));
      return res;
    } catch (e) {
      setSync({ at: new Date().toISOString(), entries: 0, orgError: e.message });
      return null;
    }
  }, [api, loadCms]);
  const runSync = useCallback((conf, cId, index, lastPublishedAt) => {
    if (conf) latestConf.current = conf;
    const next = syncChain.current.catch(() => null).then(() => doSync(cId, index, lastPublishedAt));
    syncChain.current = next;
    return next;
  }, [doSync]);

  const refreshStatus = useCallback(async () => {
    const [st, ps] = await Promise.all([
      routesRef.current.fetch('status').then((res) => (res.ok ? res.json() : null)).catch(() => null),
      fetchJson('/admin/api/cms/publish/status')
    ]);
    if (st) setStatus(st);
    if (ps.ok) setPubStatus(ps.body);
    return ps.ok ? ps.body : null;
  }, []);

  const load = useCallback(async () => {
    try {
      const [c, p, i] = await Promise.all([api.list('config'), api.list('pages'), api.list('index')]);
      const rec = c.find((r) => r.data && r.data.key === 'main');
      let raw = {};
      if (rec && rec.data.json) { try { raw = JSON.parse(rec.data.json); } catch (e) { raw = {}; } }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
      const synced = c.find((r) => r.data && r.data.key === 'orgFromData');
      if (synced && synced.data.json) { try { raw.orgFromData = JSON.parse(synced.data.json); } catch (e) { /* keep main's copy */ } }
      const merged = mergeDefaults(DEFAULTS, raw);
      setConfigId(rec ? rec.id : null); setCfg(merged); setSaved(merged);
      setOverrides(p); setIndex(i); setError('');
      const stamps = [rec, ...p].filter(Boolean).map((r) => r.updatedAt || r.createdAt || '').sort();
      setLastChange(stamps[stamps.length - 1] || '');
      const ps = await refreshStatus();
      runSync(merged, rec ? rec.id : null, i, ps && ps.lastPublishedAt);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }, [api, refreshStatus, runSync]);

  useEffect(() => { load(); }, [load]);
  useActiveNavLink(page && page.route ? page.route : `/admin/plugins/${pluginId}/seo`);

  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);
  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setOrg = (k, v) => setCfg((c) => ({ ...c, org: { ...c.org, [k]: v } }));

  // Warn before leaving with unsaved settings
  useEffect(() => {
    if (!dirty) return undefined;
    const onUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  async function save(quiet) {
    setSaving(true); if (!quiet) setNotice('');
    try {
      // CMS-synced values are stored separately (see syncCmsData)
      const { orgFromData: _synced, ...settings } = cfg;
      const data = { key: 'main', json: JSON.stringify(settings) };
      let id = configId;
      if (id) await api.update('config', id, data);
      else { const r = await api.create('config', data); id = r && r.id; setConfigId(id); }
      setSaved(cfg); setLastChange(new Date().toISOString());
      await runSync(cfg, id);
      if (!quiet) setNotice('Saved. Publish the site to apply.');
      return true;
    } catch (e) { setNotice('Error: ' + e.message); return false; } finally { setSaving(false); }
  }

  async function doPublish() {
    setPub({ busy: true, ask: false, mfa: false, error: '' }); setNotice('');
    if (dirty && !(await save(true))) { setPub({ busy: false, ask: false, mfa: false, error: '' }); return; }
    if (!dirty) await runSync(saved, configId);
    // Nothing may still be writing while Instatic bakes the pages
    await syncChain.current;
    const r = await publishSite();
    if (r.ok) {
      setPub({ busy: false, ask: false, mfa: false, error: '' });
      setNotice(`Published ${r.pages || 'all'} pages. Search and social metadata are live.`);
      await load();
    } else if (r.stepUp) setPub({ busy: false, ask: true, mfa: false, error: '' });
    else { setPub({ busy: false, ask: false, mfa: false, error: '' }); setNotice('Error: ' + r.error); }
  }

  async function confirmAndPublish(password, code) {
    setPub((p) => ({ ...p, busy: true, error: '' }));
    const c = await confirmPassword(password, code);
    if (!c.ok) { setPub((p) => ({ ...p, busy: false, mfa: p.mfa || c.mfa, error: c.error === 'Invalid credentials' ? 'Wrong password.' : c.error })); return; }
    const r = await publishSite();
    if (r.ok) {
      setPub({ busy: false, ask: false, mfa: false, error: '' });
      setNotice(`Published ${r.pages || 'all'} pages. Search and social metadata are live.`);
      await load();
    } else setPub((p) => ({ ...p, busy: false, error: r.error || 'Publishing still needs confirmation.' }));
  }

  // Auto-hide success notices
  useEffect(() => {
    if (!notice || notice.startsWith('Error')) return undefined;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const rows = useMemo(() => {
    const map = new Map();
    const now = Date.now();
    for (const r of index) {
      const d = r.data || {};
      if (!d.path) continue;
      map.set(d.path, { path: d.path, title: d.title, noindex: !!d.noindex, index: d, indexId: r.id, audit: parseAudit(d), stale: d.lastSeen ? now - Date.parse(d.lastSeen) > 30 * 86400000 : false });
    }
    for (const r of overrides) {
      const d = r.data || {};
      if (!d.path) continue;
      const row = map.get(d.path) || { path: d.path };
      row.override = d; row.overrideId = r.id;
      if (d.title) row.title = d.title;
      if (d.noindex) row.noindex = true;
      map.set(d.path, row);
    }
    return [...map.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }, [index, overrides]);

  const dupTitles = useMemo(() => {
    const seen = new Map();
    rows.filter((r) => r.index && !r.noindex && r.title).forEach((r) => seen.set(r.title, (seen.get(r.title) || 0) + 1));
    return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t));
  }, [rows]);
  const issuesOf = useMemo(() => new Map(rows.map((r) => [r.path, pageIssues(r, dupTitles)])), [rows, dupTitles]);
  const toCheck = rows.filter((r) => (issuesOf.get(r.path) || []).length).length;

  const sitemapUrl = saved.domain && status ? saved.domain.replace(/\/+$/, '') + status.sitemapPath : '';
  const postTypeCount = (tables || []).filter((t) => t.kind === 'postType').length;
  let liveTone = 'off';
  let liveText = 'Not published yet';
  if (pubStatus && pubStatus.lastPublishedAt) {
    const when = new Date(pubStatus.lastPublishedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    const pending = (lastChange && lastChange > pubStatus.lastPublishedAt) || pubStatus.draftMatchesPublished === false;
    liveTone = pending ? 'warn' : 'ok';
    liveText = pending ? (pubStatus.draftMatchesPublished === false ? 'Unpublished changes' : 'SEO changes not live yet') : `Live · ${when}`;
  }

  if (loading) return h(Text, { variant: 'muted' }, 'Loading Static SEO…');

  return h('div', { style: css.page },
    h('div', { style: css.header },
      h(Stack, { direction: 'row', gap: 8, align: 'center', wrap: true },
        h('span', { style: css.beta, title: 'Static SEO is in beta. Features may still change.' }, 'Beta'),
        h(Text, { variant: 'muted', size: 'sm' }, 'Open source · MIT'),
        FEEDBACK_URL ? h('a', { href: FEEDBACK_URL, target: '_blank', rel: 'noopener', style: { fontSize: 12, color: 'var(--text-bright)', textDecoration: 'underline' } }, 'Send feedback') : null),
      pub.ask ? null : h(Stack, { direction: 'row', gap: 12, align: 'center' },
        h(StatusPill, { tone: liveTone, text: liveText }),
        h(Button, { variant: 'primary', disabled: pub.busy, onClick: doPublish, ariaLabel: 'Publish the site' }, pub.busy ? 'Publishing…' : 'Publish site'))),
    pub.ask ? h(PublishBar, { busy: pub.busy, ask: true, mfa: pub.mfa, error: pub.error, onConfirm: confirmAndPublish, onCancel: () => setPub({ busy: false, ask: false, mfa: false, error: '' }) }) : null,
    saved.discourageSearch && tab !== 'overview' ? h(Alert, { tone: 'warning', title: 'Search engines are discouraged' }, 'All pages are published with noindex, nofollow and the sitemap is off. Switch it off under Settings → General before going live.') : null,
    error ? h(Alert, { tone: 'danger', title: 'Could not load Static SEO data' }, error) : null,
    notice ? h(Alert, { tone: notice.startsWith('Error') ? 'danger' : 'success' }, notice) : null,
    h(Tabs, { value: tab, onChange: setTab },
      h(TabList, { ariaLabel: 'Static SEO sections' },
        h(Tab, { value: 'overview' }, h('span', null, 'Overview')),
        h(Tab, { value: 'pages' }, h('span', null, toCheck ? `Pages · ${toCheck} to check` : 'Pages')),
        h(Tab, { value: 'types' }, h('span', null, `Content types${postTypeCount ? ` (${postTypeCount})` : ''}`)),
        h(Tab, { value: 'schema' }, h('span', null, 'Schema')),
        h(Tab, { value: 'settings' }, h('span', null, 'Settings'))),
      h(TabPanel, { value: 'overview' }, h(OverviewTab, { cfg, saved, status, sitemapUrl, go, rows, issuesOf, sync, liveInfo: liveText })),
      h(TabPanel, { value: 'pages' }, h(PagesTab, { cfg: saved, rows, api, reload: load, setNotice, issuesOf, filter: pagesFilter, setFilter: setPagesFilter })),
      h(TabPanel, { value: 'types' }, h(ContentTypesTab, { cfg, set, tables, rowsByTable, sync, active: typeActive, setActive: setTypeActive })),
      h(TabPanel, { value: 'schema' }, h(SchemaTab, { cfg, set, setOrg, status, tables, sync, section: schemaSection, setSection: setSchemaSection })),
      h(TabPanel, { value: 'settings' }, h(SettingsTab, {
        section: settingsSection, setSection: setSettingsSection, cfg, set, saved, sitemapUrl,
        backupProps: { pluginId, version: page && page.pluginVersion, saved, overrides, api, configId, reload: load, setNotice }
      }))),
    dirty ? h('div', { style: css.saveBar, role: 'region', 'aria-label': 'Unsaved changes' },
      h(Text, { variant: 'strong', size: 'sm' }, 'You have unsaved changes'),
      h(Stack, { direction: 'row', gap: 8 },
        h(Button, { variant: 'ghost', disabled: saving || pub.busy, onClick: () => setCfg(saved) }, 'Discard'),
        h(Button, { variant: 'secondary', disabled: saving || pub.busy, onClick: () => save(false) }, saving ? 'Saving…' : 'Save'),
        h(Button, { variant: 'primary', disabled: saving || pub.busy, onClick: doPublish }, 'Save & publish'))) : null);
}
