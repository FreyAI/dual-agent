/**
 * Opens a web page and returns its main readable text: the article found by
 * Mozilla's Readability, as light Markdown (# headings, - list items,
 * | between table cells). Plain text and JSON come back as they are.
 */
import { parseHTML } from './dom';
import type * as ReadabilityLib from '@mozilla/readability';
import { httpRequest } from './http';
import { collapseSpace as clean } from '../text';

export interface ReadPage {
  url: string;
  title: string;
  text: string;
  /** Characters before trimming to the requested length. */
  totalChars: number;
  pdf?: boolean;
}

/** Accepts bare domains ("example.com/docs"); only http and https. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https links can be read, not ${url.protocol}`);
  }
  return url.toString();
}

let privateHostsAllowed = false;

/** Lets readPage reach local addresses (the tests serve pages from localhost). */
export function allowPrivateHosts(allowed: boolean) {
  privateHostsAllowed = allowed;
}

/** Pages are cut here before parsing: the parse runs on the extension thread, and the text is trimmed to 12k chars anyway. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export async function readPage(input: string, maxChars = 6000, signal?: AbortSignal): Promise<ReadPage> {
  const url = normalizeUrl(input);
  const res = await httpRequest(url, { timeoutMs: 20_000, maxBytes: MAX_PAGE_BYTES, publicOnly: !privateHostsAllowed, signal });
  if (res.status === 404 || res.status === 410) {
    throw new Error(`that page doesn't exist (HTTP ${res.status})`);
  }
  if ([401, 402, 403, 406, 429, 503].includes(res.status)) {
    throw new Error(`the site refused the request (HTTP ${res.status}); it may need a login or block automated readers`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}`);
  }
  const type = res.contentType.toLowerCase();
  if (type.includes('application/pdf') || res.bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return {
      url: res.url,
      title: res.url.split('/').pop() || res.url,
      text: '(This is a PDF. PDFs cannot be read by this tool yet; look for an HTML version of the page or a summary elsewhere.)',
      totalChars: 0,
      pdf: true,
    };
  }
  const raw = res.text();
  let title = res.url;
  let text: string;
  if (type.includes('html') || /^\s*<(!doctype html|html)/i.test(raw)) {
    ({ title, text } = extractReadable(raw, res.url));
  } else {
    text = raw.trim();
  }
  const totalChars = text.length;
  return { url: res.url, title, text: trimText(text, maxChars), totalChars };
}

/** Loaded on first use, like linkedom (`dom.ts`). */
let readability: typeof ReadabilityLib | undefined;

/** The main text of an HTML page: parsed once, and again only when Readability finds no article. */
export function extractReadable(html: string, url = 'https://example.invalid/'): { title: string; text: string } {
  let { document } = parseHTML(html);
  const fallbackTitle = clean(document.querySelector('title')?.textContent) || url;
  readability ??= require('@mozilla/readability') as typeof ReadabilityLib;
  try {
    // The serializer hands back the article's DOM node instead of an HTML string to parse again.
    const article = new readability.Readability<any>(document as any, { charThreshold: 200, serializer: (node) => node }).parse();
    if (article?.content) {
      const text = toMarkdown(article.content);
      if (text.length >= 200) {
        return { title: clean(article.title) || fallbackTitle, text };
      }
    }
  } catch {
    // Fall through to the simple extraction.
  }
  // Readability rewrote that document; the simple extraction needs the original.
  ({ document } = parseHTML(html));
  for (const junk of document.querySelectorAll('script, style, noscript, template, svg, nav, header, footer, aside, form, iframe, [aria-hidden="true"], [hidden]')) {
    junk.remove();
  }
  const body = document.querySelector('main') ?? document.querySelector('article') ?? document.body;
  return { title: fallbackTitle, text: body ? toMarkdown(body) : '' };
}

const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'TR', 'TABLE', 'UL', 'OL', 'BR', 'HR']);

/** Light Markdown from a DOM subtree. */
function toMarkdown(root: any): string {
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (t) {
      lines.push(t);
    }
    line = '';
  };
  const walk = (node: any) => {
    if (node.nodeType === 3) {
      line += node.textContent;
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const tag = node.tagName;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE'].includes(tag)) {
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      flush();
      line = `${'#'.repeat(Number(tag[1]))} `;
      node.childNodes.forEach(walk);
      flush();
      return;
    }
    if (tag === 'LI') {
      flush();
      line = '- ';
      node.childNodes.forEach(walk);
      flush();
      return;
    }
    if (tag === 'PRE') {
      flush();
      lines.push(node.textContent.replace(/\n+$/, ''));
      return;
    }
    if (tag === 'TD' || tag === 'TH') {
      if (line.trim()) {
        line += ' | ';
      }
      node.childNodes.forEach(walk);
      return;
    }
    const block = BLOCK.has(tag);
    if (block) {
      flush();
    }
    node.childNodes.forEach(walk);
    if (block) {
      flush();
    }
  };
  walk(root);
  flush();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Cuts to maxChars, at a line or sentence end near the limit when there is one. */
export function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const cut = text.slice(0, maxChars);
  const floor = Math.floor(maxChars * 0.8);
  const nl = cut.lastIndexOf('\n');
  if (nl >= floor) {
    return cut.slice(0, nl);
  }
  const dot = cut.lastIndexOf('. ');
  if (dot >= floor) {
    return cut.slice(0, dot + 1);
  }
  return cut;
}

