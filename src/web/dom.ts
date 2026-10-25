import type * as Linkedom from 'linkedom' with { 'resolution-mode': 'import' };

let linkedom: typeof Linkedom | undefined;

/** linkedom's `parseHTML`, loaded on first use: it is ~170 modules activation doesn't need. */
export function parseHTML(html: string): ReturnType<typeof Linkedom.parseHTML> {
  // linkedom ships a CommonJS build as well; its types are only declared for the ES module one.
  linkedom ??= require('linkedom') as typeof Linkedom;
  return linkedom.parseHTML(html);
}
