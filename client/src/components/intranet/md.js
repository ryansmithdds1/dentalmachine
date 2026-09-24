// A tiny, safe Markdown renderer for intranet pages (SOPs, how-tos, announcements).
//
// Supported: # headings, paragraphs, **bold**, *italic*, `code`, [links](https://…), ![images](att:12),
// - bullet and 1. numbered lists, - [ ] / - [x] checklists, > notes, --- lines, ``` code blocks and | tables |.
//
// Safety: the text is parsed into a small tree and turned into elements with `h` (React.createElement) —
// never into an HTML string, so any <tag> typed into a page shows as text. Links go only to http(s), mailto:,
// tel:, another intranet page (page:12), a file on the page (att:12) or a path in this app (/intranet/…); anything else (javascript:,
// data:, vbscript:…) is shown as plain text. Images only come from the page's own attachments (att:12), so
// a page can't pull in outside pictures or tracking pixels.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\s]+/g;

export function safeHref(raw) {
  const s = String(raw ?? '').replace(CONTROL, '');
  if (!s) return null;
  if (/^page:\d+$/i.test(s)) return { page: Number(s.slice(5)) };
  if (/^att:\d+$/i.test(s)) return { attachment: Number(s.slice(4)) };
  if (/^\/(?![/\\])[\w\-./?=&%#]*$/.test(s)) return { path: s };
  if (/^(mailto|tel):[^<>"']+$/i.test(s)) return { href: s };
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname && !u.username && !u.password) return { href: u.href };
    } catch { /* not an address */ }
  }
  return null;
}
export function safeImage(raw) {
  const m = /^att:(\d+)$/i.exec(String(raw ?? '').replace(CONTROL, ''));
  return m ? { attachment: Number(m[1]) } : null;
}

// ---- Inline: returns a list of nodes ----
const INLINE = /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\n]*\))|(\[[^\]\n]+\]\([^)\n]*\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s\n][^*\n]*\*)|(_[^_\s\n][^_\n]*_)/g;
export function parseInline(text) {
  const out = [];
  const s = String(text ?? '');
  let last = 0;
  let m;
  // A fresh copy per call: parseInline recurses (bold inside a link…) and a shared /g regex would lose its place.
  const re = new RegExp(INLINE.source, 'g');
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    const tok = m[0];
    if (m[1]) out.push({ t: 'code', v: tok.slice(1, -1) });
    else if (m[2]) {
      const [, alt, src] = /^!\[([^\]]*)\]\(([^)]*)\)$/.exec(tok);
      const img = safeImage(src.trim());
      out.push(img ? { t: 'img', alt, ...img } : { t: 'text', v: tok });
    } else if (m[3]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]*)\)$/.exec(tok);
      const link = safeHref(href.trim());
      out.push(link ? { t: 'a', ...link, c: parseInline(label) } : { t: 'text', v: label });
    } else if (m[4] || m[5]) out.push({ t: 'b', c: parseInline(tok.slice(2, -2)) });
    else out.push({ t: 'i', c: parseInline(tok.slice(1, -1)) });
    last = m.index + tok.length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => parseInline(c.trim()));
const LIST = /^\s*([-*+]|\d+[.)])\s+/;
const CHECK = /^\[( |x|X)\]\s+/;

// ---- Blocks ----
export function parse(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1].length, c: parseInline(heading[2].replace(/\s+#+\s*$/, '')) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ t: 'quote', c: parse(quote.join('\n')) });
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (LIST.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && LIST.test(lines[i]) && /^\s*\d/.test(lines[i]) === ordered) {
        const rest = lines[i++].replace(LIST, '');
        const check = CHECK.exec(rest);
        items.push(check ? { check: check[1] !== ' ', c: parseInline(rest.replace(CHECK, '')) } : { check: null, c: parseInline(rest) });
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items, checklist: items.every((it) => it.check !== null) });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|\|)/.test(lines[i]) && !LIST.test(lines[i])) para.push(lines[i++].trim());
    if (!para.length) para.push(lines[i++].trim());
    blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
  }
  return blocks;
}

// ---- Rendering: h(type, props, ...children) — React.createElement. ----
// opts: { image(attachmentId, alt, key) → element, openAttachment(id), pageHref(id) → string, onNavigate(path, event) }
export function render(text, h, opts = {}) {
  let k = 0;
  const key = () => `m${k++}`;
  const inl = (nodes) => nodes.map((n) => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return h('code', { key: key() }, n.v);
      case 'b': return h('strong', { key: key() }, ...inl(n.c));
      case 'i': return h('em', { key: key() }, ...inl(n.c));
      case 'img': return opts.image ? opts.image(n.attachment, n.alt, key()) : h('span', { key: key(), className: 'md-img-missing' }, n.alt || 'image');
      case 'a': {
        if (n.href) return h('a', { key: key(), href: n.href, target: '_blank', rel: 'noopener noreferrer' }, ...inl(n.c));
        if (n.attachment) return h('a', { key: key(), href: '#', className: 'md-file', onClick: (e) => { e.preventDefault(); opts.openAttachment?.(n.attachment); } }, ...inl(n.c));
        const path = n.page ? (opts.pageHref ? opts.pageHref(n.page) : `/intranet/pages/${n.page}`) : n.path;
        return h('a', { key: key(), href: path, onClick: opts.onNavigate ? (e) => opts.onNavigate(path, e) : undefined }, ...inl(n.c));
      }
      default: return null;
    }
  });
  const blk = (b) => {
    switch (b.t) {
      case 'h': return h(`h${Math.min(6, b.level + 1)}`, { key: key(), className: 'md-h' }, ...inl(b.c));
      case 'p': return h('p', { key: key() }, ...inl(b.c));
      case 'hr': return h('hr', { key: key() });
      case 'pre': return h('pre', { key: key() }, h('code', null, b.v));
      case 'quote': return h('blockquote', { key: key(), className: 'md-note' }, ...b.c.map(blk));
      case 'table': return h('div', { key: key(), className: 'md-table-wrap' }, h('table', { className: 'compact-table' },
        h('thead', null, h('tr', null, ...b.head.map((c) => h('th', { key: key() }, ...inl(c))))),
        h('tbody', null, ...b.rows.map((r) => h('tr', { key: key() }, ...r.map((c) => h('td', { key: key() }, ...inl(c))))))));
      case 'ul':
      case 'ol':
        return h(b.t, { key: key(), className: b.checklist ? 'md-checklist' : undefined }, ...b.items.map((it) => (it.check === null
          ? h('li', { key: key() }, ...inl(it.c))
          : h('li', { key: key(), className: it.check ? 'done' : '' }, h('input', { type: 'checkbox', checked: it.check, readOnly: true, disabled: true, 'aria-label': it.check ? 'done' : 'to do' }), ' ', ...inl(it.c)))));
      default: return null;
    }
  };
  return parse(text).map(blk);
}
