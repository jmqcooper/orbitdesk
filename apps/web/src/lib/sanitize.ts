/**
 * Client-side defence for email HTML. The server sanitises first; this runs
 * again in the browser and the result is rendered inside a sandboxed iframe
 * with a restrictive CSP, so a miss in one layer is still contained.
 */

const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base',
  'title', 'head', 'svg', 'math', 'audio', 'video', 'source', 'track', 'canvas', 'template', 'slot',
  'noscript', 'form', 'input', 'button', 'select', 'option', 'textarea', 'dialog', 'portal',
]);

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img',
  'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span',
  'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt',
  'u', 'ul', 'wbr',
]);

const GLOBAL_ATTRS = new Set(['align', 'bgcolor', 'color', 'dir', 'height', 'lang', 'style', 'title', 'valign', 'width']);
const TAG_ATTRS: Record<string, string[]> = {
  a: ['href', 'name'],
  img: ['src', 'alt'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  table: ['border', 'cellpadding', 'cellspacing'],
  font: ['face', 'size'],
  ol: ['start', 'type'],
  col: ['span'],
  colgroup: ['span'],
};

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function cleanStyle(value: string, allowRemoteImages: boolean): string {
  // Anything that can fetch or execute is removed; layout declarations are kept.
  if (/expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding/i.test(value)) return '';
  let style = value.replace(/position\s*:\s*(fixed|sticky)/gi, 'position:static');
  if (!allowRemoteImages) style = style.replace(/url\s*\([^)]*\)/gi, 'none');
  else style = style.replace(/url\s*\(\s*(['"]?)(?!https?:|data:image\/)[^)]*\)/gi, 'none');
  return style;
}

function isSameOriginPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

export interface SanitizedHtml {
  html: string;
  /** Remote images that were held back. */
  blockedImages: number;
}

export function sanitizeEmailHtml(dirty: string, allowRemoteImages: boolean): SanitizedHtml {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${dirty}`, 'text/html');
  let blockedImages = 0;

  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (DROP_WITH_CONTENT.has(tag)) {
        child.remove();
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        // Unknown wrapper: keep its (cleaned) children, drop the element itself.
        walk(child);
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }

      const allowed = TAG_ATTRS[tag] ?? [];
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (!GLOBAL_ATTRS.has(name) && !allowed.includes(name)) child.removeAttribute(attr.name);
      }

      const style = child.getAttribute('style');
      if (style !== null) {
        const cleaned = cleanStyle(style, allowRemoteImages);
        if (cleaned) child.setAttribute('style', cleaned);
        else child.removeAttribute('style');
      }

      if (tag === 'a') {
        const href = child.getAttribute('href')?.trim() ?? '';
        if (href && SAFE_LINK.test(href)) {
          child.setAttribute('href', href);
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer nofollow');
        } else {
          child.removeAttribute('href');
        }
      }

      if (tag === 'img') {
        const src = child.getAttribute('src')?.trim() ?? '';
        const remote = /^https?:/i.test(src);
        if (DATA_IMAGE.test(src) || isSameOriginPath(src) || (remote && allowRemoteImages)) {
          child.setAttribute('src', src);
          child.setAttribute('loading', 'lazy');
          child.setAttribute('referrerpolicy', 'no-referrer');
        } else {
          child.removeAttribute('src');
          if (remote) {
            blockedImages += 1;
            child.setAttribute('data-blocked', '');
          }
        }
      }

      walk(child);
    }
  };

  walk(doc.body);
  return { html: doc.body.innerHTML, blockedImages };
}

/** A complete document for `<iframe srcdoc>`; scripts are impossible under both the sandbox and this CSP. */
export function buildEmailDocument(html: string, allowRemoteImages: boolean, origin: string): string {
  const imgSrc = allowRemoteImages ? `data: ${origin} https: http:` : `data: ${origin}`;
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
html,body{margin:0;padding:0;background:transparent}
body{font:15px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;color:#1a1c20;overflow-wrap:anywhere;word-break:normal;padding:2px 0 6px}
img{max-width:100%;height:auto}
img[data-blocked]{display:inline-block;min-width:18px;min-height:18px;border:1px dashed #cfc6b3;border-radius:3px;background:#f4f0e7}
table{max-width:100%;border-collapse:collapse}
a{color:#9a4310}
blockquote{margin:.6em 0 .6em 0;padding:0 0 0 1em;border-left:2px solid #d9d1bf;color:#575a61}
pre{white-space:pre-wrap;font:13px/1.55 ui-monospace,Menlo,monospace}
p{margin:0 0 .9em}
hr{border:0;border-top:1px solid #e3dccd}
</style></head><body>${html}</body></html>`;
}

/** Plain text of an HTML body, used for quoting when a message has no text part. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  for (const el of Array.from(doc.body.querySelectorAll('script,style,head,title'))) el.remove();
  for (const br of Array.from(doc.body.querySelectorAll('br'))) br.replaceWith('\n');
  for (const block of Array.from(doc.body.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote'))) {
    block.append('\n');
  }
  return (doc.body.textContent ?? '')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
