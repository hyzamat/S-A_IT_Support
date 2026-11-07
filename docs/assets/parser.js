// Content parser — turns the Markdown files in content/ into categories + items.
// Shared by the browser app and the Node build script, so keep it free of DOM / Node APIs.
//
// Format (see content/_FORMAT-GUIDE.md):
//   # 🌐 Category name
//   ## Item title
//   tags: dns, network        <- optional metadata lines right after the title
//   admin: yes
//   Description paragraph, lists, > notes and ```fenced code blocks```.

export const ITEM_TYPES = ['command', 'script', 'tip', 'link'];

const META_KEYS = new Set(['type', 'shell', 'admin', 'tags', 'pin', 'url', 'id']);
const SCRIPT_MIN_LINES = 5;
const ICON_RE =
  /^((?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:️|‍|⃣|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})*)\s*/u;
const LANG_ALIASES = {
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell', posh: 'powershell',
  bat: 'cmd', batch: 'cmd', dos: 'cmd',
  sh: 'bash', shell: 'bash', console: 'bash', terminal: 'bash',
  txt: 'text', plain: 'text', '': 'text',
  yml: 'yaml',
};

/** `{{name}}` = value the tech must type, `{{name:default}}` = optional with a default. */
export const varPattern = () => /\{\{\s*([A-Za-z][\w-]*)\s*(?::([^{}]*?))?\s*\}\}/g;

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const truthy = (v) => /^(y|yes|true|1|on)$/i.test(String(v ?? '').trim());
const normalizeLang = (lang) => {
  const l = String(lang || '').toLowerCase();
  return LANG_ALIASES[l] ?? l;
};

/**
 * @param {{name: string, text: string}[]} files  Markdown files, already in display order.
 * @returns {{categories: object[], items: object[], warnings: {file: string, line: number, message: string}[]}}
 */
export function parseContent(files) {
  const categories = [];
  const catMap = new Map();
  const items = [];
  const warnings = [];
  const ids = new Set();

  for (const file of files) parseFile(file);
  return { categories: categories.filter((c) => c.count > 0), items, warnings };

  function getCategory(heading) {
    const m = ICON_RE.exec(heading);
    const icon = m ? m[1] : '📁';
    const name = (m ? heading.slice(m[0].length) : heading).trim() || 'General';
    const id = slugify(name) || `category-${categories.length + 1}`;
    let cat = catMap.get(id);
    if (!cat) {
      cat = { id, name, icon, count: 0 };
      catMap.set(id, cat);
      categories.push(cat);
    }
    return cat;
  }

  function parseFile({ name: fileName, text }) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    const warn = (line, message) => warnings.push({ file: fileName, line, message });
    let cat = null;
    let item = null;
    let block = null;
    let fence = null;
    let inComment = false;
    let inMeta = false;

    const finishItem = () => {
      if (item) finalizeItem(item, warn);
      item = null;
      block = null;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      const t = line.trim();
      let m;

      if (fence) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
        if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) {
          item.blocks.push(makeCode(fence));
          fence = null;
        } else {
          fence.lines.push(line);
        }
        continue;
      }
      if (inComment) {
        if (t.includes('-->')) inComment = false;
        continue;
      }
      if (t.startsWith('<!--')) {
        if (!t.includes('-->')) inComment = true;
        continue;
      }
      if ((m = /^#\s+(.+?)\s*#*\s*$/.exec(line))) {
        finishItem();
        cat = getCategory(m[1]);
        continue;
      }
      if ((m = /^##\s+(.+?)\s*#*\s*$/.exec(line))) {
        finishItem();
        if (!cat) {
          warn(lineNo, 'Item found before any "# Category" heading — placed in "General".');
          cat = getCategory('General');
        }
        item = { title: m[1], category: cat, meta: {}, blocks: [], file: fileName, line: lineNo };
        inMeta = true;
        continue;
      }
      if (!item) continue; // text between a category heading and its first item is ignored

      if (inMeta) {
        if (t === '') continue;
        m = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(t);
        if (m && META_KEYS.has(m[1].toLowerCase())) {
          item.meta[m[1].toLowerCase()] = m[2].trim();
          continue;
        }
        inMeta = false;
      }

      if ((m = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)\s*(.*)$/.exec(line))) {
        fence = { indent: m[1].length, marker: m[2], lang: m[3], label: m[4].trim(), lines: [], line: lineNo };
        block = null;
        continue;
      }
      if (t === '') {
        if (block && block.t === 'p') block = null;
        else if (block) block.gap = true;
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        block = null;
        continue;
      }
      if ((m = /^>\s?(.*)$/.exec(t))) {
        if (block && block.t === 'note' && !block.gap) block.text += ' ' + m[1];
        else item.blocks.push((block = { t: 'note', text: m[1] }));
        continue;
      }
      if ((m = /^(\d+)[.)]\s+(.*)$/.exec(t))) {
        if (block && block.t === 'ol') block.items.push(m[2]);
        else item.blocks.push((block = { t: 'ol', start: Number(m[1]), items: [m[2]] }));
        block.gap = false;
        continue;
      }
      if ((m = /^[-*+]\s+(.*)$/.exec(t))) {
        if (block && block.t === 'ul') block.items.push(m[1]);
        else item.blocks.push((block = { t: 'ul', items: [m[1]] }));
        block.gap = false;
        continue;
      }
      if (block && (block.t === 'ol' || block.t === 'ul') && !block.gap && /^\s+/.test(line)) {
        block.items[block.items.length - 1] += ' ' + t; // indented continuation of a list item
        continue;
      }
      if (block && block.t === 'p') {
        block.text += ' ' + t;
        continue;
      }
      item.blocks.push((block = { t: 'p', text: t }));
    }

    if (fence) {
      warn(fence.line, 'Code block was never closed with ``` — closed at end of file.');
      item.blocks.push(makeCode(fence));
    }
    finishItem();
  }

  function makeCode(f) {
    const lines = f.lines.map((l) => {
      let n = 0;
      while (n < f.indent && l[n] === ' ') n++;
      return l.slice(n).replace(/\s+$/, '');
    });
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const code = lines.join('\n');
    const vars = [];
    const seen = new Map();
    for (const m of code.matchAll(varPattern())) {
      const def = m[2] === undefined ? undefined : m[2].trim();
      const known = seen.get(m[1]);
      if (!known) {
        const v = { name: m[1], def };
        seen.set(m[1], v);
        vars.push(v);
      } else if (known.def === undefined && def !== undefined) {
        known.def = def;
      }
    }
    return { t: 'code', lang: normalizeLang(f.lang), label: f.label, code, lineCount: lines.length, vars };
  }

  function finalizeItem(raw, warn) {
    const { meta } = raw;
    const codes = raw.blocks.filter((b) => b.t === 'code');

    let url = '';
    if (meta.url) {
      if (/^https?:\/\/\S+$/i.test(meta.url)) url = meta.url;
      else warn(raw.line, `Ignored url "${meta.url}" — it must start with http:// or https://`);
    }

    let type = (meta.type || '').toLowerCase();
    if (type && !ITEM_TYPES.includes(type)) {
      warn(raw.line, `Unknown type "${meta.type}" — use command, script, tip or link.`);
      type = '';
    }
    if (!type) {
      if (url) type = 'link';
      else if (codes.some((c) => c.lineCount >= SCRIPT_MIN_LINES)) type = 'script';
      else if (raw.blocks.some((b) => b.t === 'ol')) type = 'tip';
      else type = codes.length ? 'command' : 'tip';
    }
    if (type === 'link' && !url) warn(raw.line, `"${raw.title}" is a link but has no valid "url:" line.`);
    if (!raw.blocks.length && !url) warn(raw.line, `"${raw.title}" has no content.`);

    const tags = String(meta.tags || '')
      .split(/[,;]/)
      .map((s) => s.trim().replace(/^#/, ''))
      .filter(Boolean);

    let id = slugify(meta.id || `${raw.category.id}-${raw.title}`) || `item-${items.length + 1}`;
    if (ids.has(id)) {
      let n = 2;
      while (ids.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    ids.add(id);

    const shell = normalizeLang(meta.shell || (codes[0] && codes[0].lang) || '');
    const text = raw.blocks
      .map((b) => (b.t === 'code' ? b.label : b.items ? b.items.join(' ') : b.text))
      .join(' ');
    const code = codes.map((c) => c.code).join('\n');

    raw.category.count++;
    items.push({
      id,
      title: raw.title,
      type,
      category: raw.category.id,
      shell: shell === 'text' ? '' : shell,
      admin: truthy(meta.admin),
      pin: truthy(meta.pin),
      tags,
      url,
      blocks: raw.blocks.map(({ gap, ...b }) => b),
      order: items.length,
      source: `${raw.file}:${raw.line}`,
      search: {
        title: raw.title.toLowerCase(),
        tags: tags.join(' ').toLowerCase(),
        text: `${text} ${url}`.toLowerCase(),
        code: code.toLowerCase(),
        extra: `${raw.category.name} ${type} ${shell}`.toLowerCase(),
      },
    });
  }
}
