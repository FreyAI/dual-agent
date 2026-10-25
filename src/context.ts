import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { withTimeout } from './async';
import { swallowed } from './diag/log';
import { cachedIndex, indexRepo } from './code/repoIndex';
import { retrievalBlock } from './code/retrieve';

/** A content block of a user message, as the Messages API takes it. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** What the chat shows about the file open in the editor. */
export interface EditorInfo {
  name: string;
  path: string;
  /** "12-30" when lines are selected. */
  selection?: string;
}

/** Larger attachments and editor files are read by the agent as needed: inline text is re-sent on every later call. */
const MAX_INLINE_TEXT = 16_000;
const MAX_INLINE_ACTIVE_FILE = 12_000;
const MAX_IMAGE = 5_000_000;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * The text editor the user last worked in. Focusing a chat tab clears
 * `activeTextEditor`, so remember the last one instead.
 */
let lastEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;

export function trackEditor(onChange: () => void): vscode.Disposable {
  const update = (editor: vscode.TextEditor | undefined) => {
    if (editor && editor.document.uri.scheme === 'file') {
      lastEditor = editor;
      onChange();
    }
  };
  return vscode.Disposable.from(
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.window.onDidChangeTextEditorSelection((e) => update(e.textEditor)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (lastEditor?.document === doc) {
        lastEditor = undefined;
        onChange();
      }
    }),
  );
}

/** The file editor to describe: the last one used, else whichever is active now. */
function currentEditor(): vscode.TextEditor | undefined {
  if (lastEditor && !lastEditor.document.isClosed) {
    return lastEditor;
  }
  const active = vscode.window.activeTextEditor;
  return active && active.document.uri.scheme === 'file' && !active.document.isClosed ? active : undefined;
}

export function editorInfo(): EditorInfo | undefined {
  const editor = currentEditor();
  if (!editor) {
    return undefined;
  }
  const file = editor.document.uri.fsPath;
  const sel = editor.selection;
  return {
    name: path.basename(file),
    path: file,
    selection: sel.isEmpty ? undefined : `${sel.start.line + 1}-${sel.end.line + 1}`,
  };
}

/** The file open (or last open) in an editor, for ranking; not read here. */
export function editorFile(): string | undefined {
  return currentEditor()?.document.uri.fsPath;
}

/**
 * The "Likely relevant" block for a message that names no file: the files and
 * definitions the repository index ranks for it (retrieve.ts). A cold index is
 * skipped after a short wait rather than start indexing and hold the turn.
 */
export async function likelyRelevant(root: string, text: string, recent: string[]): Promise<string | undefined> {
  let files = cachedIndex(root);
  if (!files) {
    files = (await withTimeout(indexRepo(root), RETRIEVAL_WAIT_MS, 'Indexing the repository').catch((err) => {
      swallowed('Building the index for context', err);
      return undefined;
    })) ?? cachedIndex(root);
    if (!files) {
      return undefined;
    }
  }
  return retrievalBlock(files, text, recent);
}

const RETRIEVAL_WAIT_MS = 300;

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');

/**
 * Describes the open file for the agent. The file and the selection are
 * included only when small and changed since this conversation last saw them
 * (`seen` maps paths, and path#selection, to hashes); otherwise the agent gets
 * the path and reads what it needs.
 */
export function editorContext(seen: Map<string, string>): string | undefined {
  const editor = currentEditor();
  if (!editor) {
    return undefined;
  }
  const doc = editor.document;
  const file = doc.uri.fsPath;
  const parts = [`The user is looking at ${file} in the editor${doc.isDirty ? ' (it has unsaved changes)' : ''}.`];
  const sel = editor.selection;
  if (!sel.isEmpty) {
    const lines = `lines ${sel.start.line + 1}-${sel.end.line + 1}`;
    const picked = doc.getText(sel);
    const key = `${file}#selection`;
    if (seen.get(key) === sha1(picked)) {
      parts.push(`They still have ${lines} selected (unchanged).`);
    } else if (picked.length <= MAX_INLINE_ACTIVE_FILE) {
      seen.set(key, sha1(picked));
      parts.push(`They selected ${lines}:\n\`\`\`${doc.languageId}\n${picked}\n\`\`\``);
    } else {
      parts.push(`They selected ${lines}; read them if needed.`);
    }
  }
  const text = doc.getText();
  const hash = sha1(text);
  if (seen.get(file) === hash) {
    parts.push('Its contents are unchanged since you last saw them.');
  } else if (text.length <= MAX_INLINE_ACTIVE_FILE && sel.isEmpty) {
    seen.set(file, hash);
    parts.push(`Current contents of ${path.basename(file)}:\n\`\`\`${doc.languageId}\n${text}\n\`\`\``);
  } else if (sel.isEmpty) {
    parts.push('It is large, so read the parts you need.');
  }
  return parts.join('\n\n');
}

/** After the agent writes a file it knows the contents, so the editor context needn't send them again. */
export function markSeen(seen: Map<string, string>, file: string) {
  try {
    seen.set(file, sha1(fs.readFileSync(file, 'utf8')));
  } catch {
    seen.delete(file);
  }
}

/** Turns attached files into message content: text inline, images as image blocks, anything else by path. */
export function attachmentBlocks(files: string[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const file of files) {
    const name = path.basename(file);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      blocks.push({ type: 'text', text: `Attached file ${file} could not be read.` });
      continue;
    }
    const imageType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (imageType && size <= MAX_IMAGE) {
      blocks.push({ type: 'text', text: `Attached image: ${file}` });
      try {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: imageType, data: fs.readFileSync(file).toString('base64') } });
      } catch {
        blocks.push({ type: 'text', text: `Attached image ${file} could not be read.` });
      }
      continue;
    }
    if (size <= MAX_INLINE_TEXT && !imageType) {
      let buf: Buffer | undefined;
      try {
        buf = fs.readFileSync(file);
      } catch {
        // A folder or unreadable: described by path below.
      }
      if (buf && !buf.subarray(0, 8000).includes(0)) {
        blocks.push({ type: 'text', text: `Attached file ${file}:\n\`\`\`\n${buf.toString('utf8')}\n\`\`\`` });
        continue;
      }
    }
    blocks.push({ type: 'text', text: `Attached file ${file} (${name}, ${size.toLocaleString()} bytes). Read it with your tools if you need it.` });
  }
  return blocks;
}
