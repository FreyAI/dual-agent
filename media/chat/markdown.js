// @ts-check
/** The small markdown renderer for replies, plans and user messages. */
/** Web links open in the browser; `src/a.ts#L42` opens the file (relative to the project) at that line; other schemes stay text. */
function link(text, href) {
  if (/^https?:\/\//.test(href)) {
    return `<a href="${href}">${text}</a>`;
  }
  if (/^[a-z][\w+.-]*:(?![\\/])/i.test(href)) {
    return text;
  }
  const [, file, line] = href.match(/^(.*?)(?:#L(\d+)(?:-L?\d+)?)?$/);
  const root = state?.cwd;
  const abs = !root || /^([\\/]|[A-Za-z]:)/.test(file) ? file : `${root}/${file}`;
  return `<a data-open="${abs}"${line ? ` data-line="${line}"` : ''}>${text}</a>`;
}

/** Code spans are set aside first so `**` or `[x](y)` inside them stay literal. */
function inline(s) {
  const codes = [];
  return s
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => link(text, href))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cells = (row, tag) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => `<${tag}>${inline(c.trim())}</${tag}>`).join('');

/** Small markdown renderer: fenced code, headings, nested lists, tables, quotes, rules, paragraphs and inline marks. */
function renderMarkdown(src) {
  const out = [];
  const parts = escapeHtml(src).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[\w+-]*\n/, '');
      out.push(`<pre><code>${body}</code></pre>`);
      return;
    }
    /** Open lists, innermost last. Items stay open so a deeper list nests inside its <li>. */
    const lists = [];
    const closeLists = (indent) => {
      while (lists.length && lists[lists.length - 1].indent > indent) {
        out.push(`</${lists.pop().tag}>`);
      }
    };
    const lines = part.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      const item = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (item && !/^\s*([-*])(\s*\1){2,}\s*$/.test(line)) {
        const indent = item[1].length;
        closeLists(indent);
        if (!lists.length || lists[lists.length - 1].indent < indent) {
          lists.push({ indent, tag: /\d/.test(item[2]) ? 'ol' : 'ul' });
          out.push(`<${lists[lists.length - 1].tag}>`);
        }
        out.push(`<li>${inline(item[3])}`);
        continue;
      }
      closeLists(-1);
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      const quote = line.match(/^\s*&gt;\s?(.*)$/);
      if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[j + 1] ?? '')) {
        let table = `<div class="table-wrap"><table><thead><tr>${cells(line, 'th')}</tr></thead><tbody>`;
        for (j += 2; j < lines.length && TABLE_ROW.test(lines[j]); j++) {
          table += `<tr>${cells(lines[j], 'td')}</tr>`;
        }
        j--;
        out.push(`${table}</tbody></table></div>`);
      } else if (heading) {
        const h = Math.min(heading[1].length + 2, 6);
        out.push(`<h${h}>${inline(heading[2])}</h${h}>`);
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr>');
      } else if (quote) {
        // Consecutive quoted lines make one block.
        const last = out[out.length - 1];
        if (last?.endsWith('</blockquote>')) {
          out[out.length - 1] = `${last.slice(0, -'</blockquote>'.length)}<br>${inline(quote[1])}</blockquote>`;
        } else {
          out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
        }
      } else if (line.trim()) {
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeLists(-1);
  });
  return out.join('');
}

/**
 * How much of a streamed reply is finished: up to its last blank line outside a code block, so rendering
 * that part and the rest separately gives the same HTML as rendering it whole. `from` is an earlier result.
 */
function frozenEnd(text, from) {
  let end = from;
  let fences = 0;
  for (let seg = from, i = text.indexOf('\n\n', from); i >= 0; seg = i, i = text.indexOf('\n\n', i + 1)) {
    fences += text.slice(seg, i).split('```').length - 1;
    // Not after a quote either: a later quoted line joins its blockquote across blank lines.
    if (fences % 2 === 0 && !/^\s*>/.test(lastTextLine(text, i))) {
      end = i + 2;
    }
  }
  return end;
}

/** The last line with text in it before `end`. */
function lastTextLine(text, end) {
  let line = '';
  while (end > 0 && !line.trim()) {
    const start = text.lastIndexOf('\n', end - 1) + 1;
    line = text.slice(start, end);
    end = start - 1;
  }
  return line;
}
