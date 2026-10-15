// Static SEO – site editor integration: an "SEO" panel in the left sidebar for the open page.
// Plain ESM, no build step: React and host UI come from the admin's import map.
import { createElement as h, useState, useEffect } from 'react';
import { useEditorStore } from '@instatic/host-hooks';
import { Input, Textarea, Switch, Button, Stack, Text, Alert } from '@instatic/host-ui';

const PLUGIN_ID = 'staticseo.core';
const COMPONENT_ID = 'staticseo-data';
const WORKSPACE_URL = `/admin/plugins/${PLUGIN_ID}/seo`;

let pluginApi = null;

const css = {
  serp: { padding: 12, borderRadius: 'var(--card-radius, 8px)', background: 'var(--bg-surface-2)', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 3 },
  serpUrl: { fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  serpTitle: { fontSize: 15, lineHeight: 1.3, color: 'var(--accent-6, #8ab4f8)' },
  serpDesc: { fontSize: 12, lineHeight: 1.45, color: 'var(--text)' },
  link: { color: 'var(--text-bright)', textDecoration: 'underline', fontSize: 12 }
};

function counter(value, ideal) {
  const n = (value || '').length;
  return h('span', { style: { fontSize: 11, color: n > ideal ? 'var(--warning-text)' : 'var(--text-muted)' } }, `${n} / ${ideal}`);
}

function pagePath(slug, trailingSlash) {
  if (!slug || slug === 'index') return '/';
  const p = '/' + String(slug).replace(/^\/+|\/+$/g, '');
  return trailingSlash ? p + '/' : p;
}

function usesComponent(page) {
  const nodes = page && page.nodes ? Object.values(page.nodes) : [];
  return nodes.some((n) => n && n.moduleId === 'base.visual-component-ref' && n.props && n.props.componentId === COMPONENT_ID);
}

function WorkspaceLink() {
  return h('a', { href: WORKSPACE_URL, target: '_blank', rel: 'noopener', style: css.link }, 'Open the SEO workspace ↗');
}

function SeoPanel() {
  const activeDocument = useEditorStore((s) => s.activeDocument);
  const activePageId = useEditorStore((s) => s.activePageId);
  const pages = useEditorStore((s) => (s.site ? s.site.pages : null));
  const pageId = activeDocument && activeDocument.kind === 'page' ? activeDocument.pageId : activePageId;
  const page = pages && pageId ? pages.find((p) => p.id === pageId) : null;

  const [cfg, setCfg] = useState(null);
  const [record, setRecord] = useState(null);
  const [form, setForm] = useState({ title: '', description: '', image: '', noindex: false });
  const [state, setState] = useState({ loading: true, busy: false, msg: '', error: '' });

  const path = page && cfg ? pagePath(page.slug, cfg.trailingSlash !== false) : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await pluginApi.cms.storage.collection('config').list({ filter: { key: 'main' }, limit: 1 });
        let parsed = {};
        const rec = c.records && c.records[0];
        if (rec && rec.data && rec.data.json) { try { parsed = JSON.parse(rec.data.json); } catch (e) { parsed = {}; } }
        if (!cancelled) setCfg(parsed);
      } catch (e) {
        if (!cancelled) { setCfg({}); setState((s) => ({ ...s, error: e.message })); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, msg: '' }));
    (async () => {
      try {
        const r = await pluginApi.cms.storage.collection('pages').list({ filter: { path }, limit: 1 });
        const rec = (r.records && r.records[0]) || null;
        if (cancelled) return;
        setRecord(rec);
        const d = (rec && rec.data) || {};
        setForm({ title: d.title || '', description: d.description || '', image: d.image || '', noindex: !!d.noindex });
        setState((s) => ({ ...s, loading: false, error: '' }));
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, loading: false, error: e.message }));
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  if (!page) return h(Text, { variant: 'muted', size: 'sm' }, 'Open a page to edit its SEO.');

  if (page.template && page.template.enabled) {
    const target = page.template.target || {};
    const placed = usesComponent(page);
    return h(Stack, { gap: 12 },
      target.kind === 'everywhere'
        ? (placed
          ? h(Alert, { tone: 'success', title: 'Static SEO is connected' }, 'This layout contains the “Static SEO” component.')
          : h(Alert, { tone: 'warning', title: 'Add the Static SEO component' }, 'Insert → Components → “Static SEO”, once, anywhere in this layout. It renders nothing visible.'))
        : h(Alert, { tone: 'info', title: 'Template' }, target.kind === 'postTypes'
          ? 'Entries use their own “SEO title” and “SEO description” fields in the Content workspace. Image and indexing per URL are set in the SEO workspace.'
          : 'Templates have no SEO settings of their own.'),
      h(WorkspaceLink));
  }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const siteName = (cfg && cfg.siteName) || '';
  const sep = (cfg && cfg.titleSeparator) || '|';
  const isHome = page.slug === 'index';
  const fallbackTitle = isHome ? 'Site meta title (Settings → General)' : siteName ? `${page.title} ${sep} ${siteName}` : page.title;
  const domain = ((cfg && cfg.domain) || '').replace(/\/+$/, '');

  async function save() {
    setState((s) => ({ ...s, busy: true, msg: '' }));
    try {
      const data = { path, noindex: !!form.noindex };
      if (form.title.trim()) data.title = form.title.trim();
      if (form.description.trim()) data.description = form.description.trim();
      if (form.image.trim()) data.image = form.image.trim();
      const coll = pluginApi.cms.storage.collection('pages');
      const saved = record ? await coll.update(record.id, data) : await coll.create(data);
      setRecord(saved || record);
      setState((s) => ({ ...s, busy: false, msg: 'Saved – applied on next publish.' }));
    } catch (e) {
      setState((s) => ({ ...s, busy: false, msg: 'Error: ' + e.message }));
    }
  }

  async function reset() {
    if (!record) return;
    setState((s) => ({ ...s, busy: true, msg: '' }));
    try {
      await pluginApi.cms.storage.collection('pages').delete(record.id);
      setRecord(null);
      setForm({ title: '', description: '', image: '', noindex: false });
      setState((s) => ({ ...s, busy: false, msg: 'Reset – applied on next publish.' }));
    } catch (e) {
      setState((s) => ({ ...s, busy: false, msg: 'Error: ' + e.message }));
    }
  }

  if (!cfg || state.loading) return h(Text, { variant: 'muted', size: 'sm' }, 'Loading…');

  return h(Stack, { gap: 12 },
    state.error ? h(Alert, { tone: 'danger', title: 'Static SEO' }, state.error) : null,
    !domain ? h(Alert, { tone: 'warning', title: 'Setup incomplete' }, 'Set your domain and site name in the SEO workspace.') : null,
    h('div', { style: css.serp, 'aria-label': 'Search result preview' },
      h('div', { style: css.serpUrl }, (domain || '') + path),
      h('div', { style: css.serpTitle }, form.title || fallbackTitle),
      h('div', { style: css.serpDesc }, form.description || 'Site default description')),
    h(Stack, { gap: 4 }, h(Input, { label: 'SEO title', value: form.title, placeholder: fallbackTitle, onChange: (v) => set('title', v) }), counter(form.title || (isHome ? '' : fallbackTitle), 60)),
    h(Stack, { gap: 4 }, h(Textarea, { label: 'Meta description', rows: 4, value: form.description, placeholder: 'Uses the site default', onChange: (v) => set('description', v) }), counter(form.description, 155)),
    h(Input, { label: 'Social image', value: form.image, placeholder: 'Default social image', description: 'Media path, 1200 × 630 px.', onChange: (v) => set('image', v) }),
    h(Switch, { label: 'Hide from search engines', description: 'noindex, removed from the sitemap', checked: form.noindex, onChange: (v) => set('noindex', v) }),
    h(Stack, { direction: 'row', gap: 8 },
      h(Button, { variant: 'primary', disabled: state.busy || !path, onClick: save }, 'Save'),
      record ? h(Button, { variant: 'ghost', disabled: state.busy, onClick: reset }, 'Reset') : null),
    state.msg ? h(Text, { variant: 'muted', size: 'sm' }, state.msg) : null,
    h(WorkspaceLink));
}

export function activate(api) {
  pluginApi = api;
  api.editor.panels.register({
    id: `${PLUGIN_ID}.seo`,
    label: 'SEO',
    iconName: 'text-start-t',
    accent: 'mint',
    component: SeoPanel
  });
}
