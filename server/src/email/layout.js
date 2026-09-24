// The one look for emails the practice's staff get (metric digests, "task assigned", "claim denied"…): a
// single-column, table-based layout with inline styles (what email programs actually honour), 600px wide on a
// computer and full width on a phone, plus a plain-text version built from the same blocks.
//
// An email is a list of blocks:
//   { type: 'heading', text }                         a section title
//   { type: 'text', text, muted? }                    a paragraph
//   { type: 'stats', items: [{ label, value, change?, good?, edge?, sub? }] }   number tiles, two per row
//                                                     (good: the change is good news; edge: true / false / 'watch')
//   { type: 'list', title?, items: [text], more? }    a short list (people to call, claims to chase)
//   { type: 'button', text, url }                     a link to act on it in the app
//   { type: 'callout', title?, text, tone?, label? }  a highlighted box (tone: info | warn | ai)
//   { type: 'divider' }

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const C = { text: '#121a2a', muted: '#5d6679', faint: '#8a93a5', border: '#e4e8ee', bg: '#f4f6f9', panel: '#ffffff', primary: '#0d9488', primaryInk: '#0f5f58', primarySoft: '#e3f5f2', ok: '#15803d', okSoft: '#e7f6ec', warn: '#b45309', warnSoft: '#fef5e2', bad: '#c2410c', info: '#1d4ed8', infoSoft: '#eaf0ff', ai: '#6d28d9', aiSoft: '#f3effe' };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '#');

function changeHtml(item) {
  if (item.change == null || item.change === '') return '';
  const color = item.good === true ? C.ok : item.good === false ? C.bad : C.muted;
  return `<div style="font-size:12px;line-height:16px;color:${color};margin-top:2px">${esc(item.change)}</div>`;
}

function statTile(item) {
  if (!item) return '<td class="dm-tile" width="50%" style="width:50%;padding:6px"></td>';
  // The left edge shows how it stands (against its goal when it has one); the change line shows the trend.
  const standing = item.edge !== undefined ? item.edge : item.good;
  const edge = standing === true ? C.ok : standing === false ? C.bad : standing === 'watch' ? C.warn : C.border;
  return `<td class="dm-tile" width="50%" valign="top" style="width:50%;padding:6px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.border};border-left:4px solid ${edge};border-radius:8px;background:${C.panel}">
      <tr><td style="padding:10px 12px">
        <div style="font-size:12px;line-height:16px;color:${C.muted};text-transform:uppercase;letter-spacing:0.03em">${esc(item.label)}</div>
        <div style="font-size:22px;line-height:28px;font-weight:700;color:${C.text};margin-top:2px">${esc(item.value)}</div>
        ${changeHtml(item)}
        ${item.sub ? `<div style="font-size:12px;line-height:16px;color:${C.faint};margin-top:2px">${esc(item.sub)}</div>` : ''}
      </td></tr>
    </table>
  </td>`;
}

function blockHtml(b) {
  switch (b.type) {
    case 'heading':
      return `<tr><td style="padding:18px 20px 4px;font-size:16px;line-height:22px;font-weight:700;color:${C.text}">${esc(b.text)}</td></tr>`;
    case 'text':
      return `<tr><td style="padding:4px 20px;font-size:14px;line-height:21px;color:${b.muted ? C.muted : C.text}">${esc(b.text)}</td></tr>`;
    case 'stats': {
      const rows = [];
      for (let i = 0; i < b.items.length; i += 2) rows.push(`<tr>${statTile(b.items[i])}${statTile(b.items[i + 1])}</tr>`);
      return `<tr><td style="padding:4px 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table></td></tr>`;
    }
    case 'list':
      return `<tr><td style="padding:4px 20px">
        ${b.title ? `<div style="font-size:13px;line-height:18px;font-weight:600;color:${C.text};margin:4px 0">${esc(b.title)}</div>` : ''}
        <ul style="margin:0;padding:0 0 0 18px;font-size:14px;line-height:21px;color:${C.text}">${b.items.map((x) => `<li style="margin:0 0 2px">${esc(x)}</li>`).join('')}</ul>
        ${b.more ? `<div style="font-size:12px;line-height:18px;color:${C.muted};margin-top:2px">${esc(b.more)}</div>` : ''}
      </td></tr>`;
    case 'button':
      return `<tr><td style="padding:10px 20px 6px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:${C.primary}">
          <a href="${esc(safeUrl(b.url))}" style="display:inline-block;padding:10px 16px;font-size:14px;line-height:18px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${esc(b.text)}</a>
        </td></tr></table>
      </td></tr>`;
    case 'callout': {
      const tone = { info: [C.infoSoft, C.info], warn: [C.warnSoft, C.warn], ai: [C.aiSoft, C.ai] }[b.tone || 'info'] || [C.infoSoft, C.info];
      return `<tr><td style="padding:8px 20px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${tone[0]};border-radius:8px"><tr><td style="padding:12px 14px">
          ${b.label ? `<div style="font-size:11px;line-height:14px;font-weight:700;color:${tone[1]};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">${esc(b.label)}</div>` : ''}
          ${b.title ? `<div style="font-size:14px;line-height:20px;font-weight:700;color:${C.text};margin-bottom:2px">${esc(b.title)}</div>` : ''}
          <div style="font-size:14px;line-height:21px;color:${C.text}">${esc(b.text)}</div>
        </td></tr></table>
      </td></tr>`;
    }
    case 'divider':
      return `<tr><td style="padding:10px 20px"><div style="border-top:1px solid ${C.border};height:1px;line-height:1px;font-size:1px">&nbsp;</div></td></tr>`;
    default:
      return '';
  }
}

function blockText(b) {
  switch (b.type) {
    case 'heading': return `\n${b.text.toUpperCase()}\n${'-'.repeat(Math.min(60, b.text.length))}`;
    case 'text': return b.text;
    case 'stats': return b.items.map((i) => `${i.label}: ${i.value}${i.change ? ` (${i.change})` : ''}${i.sub ? ` · ${i.sub}` : ''}`).join('\n');
    case 'list': return [b.title, ...b.items.map((x) => `  - ${x}`), b.more ? `  ${b.more}` : null].filter(Boolean).join('\n');
    case 'button': return `${b.text}: ${b.url}`;
    case 'callout': return [b.label ? `[${b.label}]` : null, b.title, b.text].filter(Boolean).join('\n');
    case 'divider': return '';
    default: return '';
  }
}

// { html, text } for an email. footer: lines under the body (why they got it); unsubscribeUrl adds the link.
export function renderEmail({ brand, title, preheader = '', blocks = [], footer = [], unsubscribeUrl = null }) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only"><title>${esc(title)}</title>
<style>
  @media only screen and (max-width: 480px) {
    .dm-wrap { padding: 0 !important; }
    .dm-card { border-radius: 0 !important; }
    .dm-tile { display: block !important; width: 100% !important; }
  }
</style></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td class="dm-wrap" align="center" style="padding:20px 12px">
  <table role="presentation" class="dm-card" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.panel};border:1px solid ${C.border};border-radius:12px;font-family:${FONT}">
    <tr><td style="padding:16px 20px 12px;border-bottom:1px solid ${C.border}">
      <div style="font-size:12px;line-height:16px;color:${C.primaryInk};font-weight:700;letter-spacing:0.04em;text-transform:uppercase">${esc(brand || 'Dental Machine')}</div>
      <div style="font-size:20px;line-height:26px;font-weight:700;color:${C.text};margin-top:2px">${esc(title)}</div>
    </td></tr>
    ${blocks.map(blockHtml).join('\n')}
    <tr><td style="padding:16px 20px 18px;border-top:1px solid ${C.border};font-size:12px;line-height:18px;color:${C.faint}">
      ${footer.map((f) => `<div>${esc(f)}</div>`).join('')}
      ${unsubscribeUrl ? `<div style="margin-top:6px"><a href="${esc(safeUrl(unsubscribeUrl))}" style="color:${C.muted};text-decoration:underline">Unsubscribe from this email</a></div>` : ''}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const text = [
    brand ? brand.toUpperCase() : null, title, '='.repeat(Math.min(60, title.length)), '',
    ...blocks.map(blockText).filter((x) => x !== null), '', '--', ...footer,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : null,
  ].filter((x) => x !== null).join('\n').replace(/\n{3,}/g, '\n\n');
  return { html, text };
}
