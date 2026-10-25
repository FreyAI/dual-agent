/**
 * A small stand-in for the `vscode` module so the extension's modules can be
 * tested in plain Node. Import this before any module under test.
 */
import Module = require('module');
import * as path from 'path';

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(value: T) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose() {
    this.listeners = [];
  }
}

export interface FakeUri {
  scheme: string;
  fsPath: string;
  path: string;
  toString(): string;
}

const Uri = {
  file: (p: string): FakeUri => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
  joinPath: (base: FakeUri, ...parts: string[]): FakeUri => Uri.file(path.join(base.fsPath, ...parts)),
};

export interface FakeEditor {
  document: {
    uri: FakeUri;
    isClosed: boolean;
    isDirty: boolean;
    languageId: string;
    getText(range?: FakeSelection): string;
  };
  selection: FakeSelection;
}

interface FakeSelection {
  isEmpty: boolean;
  start: { line: number };
  end: { line: number };
}

/** A text editor showing `text`, with lines `selected` (1-based, inclusive) highlighted. */
export function fakeEditor(file: string, text: string, selected?: [number, number], languageId = 'typescript'): FakeEditor {
  const selection: FakeSelection = selected
    ? { isEmpty: false, start: { line: selected[0] - 1 }, end: { line: selected[1] - 1 } }
    : { isEmpty: true, start: { line: 0 }, end: { line: 0 } };
  return {
    document: {
      uri: Uri.file(file),
      isClosed: false,
      isDirty: false,
      languageId,
      getText: (range) =>
        range ? text.split('\n').slice(range.start.line, range.end.line + 1).join('\n') : text,
    },
    selection,
  };
}

export const config: Record<string, unknown> = {};
const state = {
  activeTextEditor: undefined as FakeEditor | undefined,
  workspaceFolders: [] as { uri: FakeUri; name: string; index: number }[],
};

export const events = {
  activeEditor: new EventEmitter<FakeEditor | undefined>(),
  selection: new EventEmitter<{ textEditor: FakeEditor }>(),
  closeDocument: new EventEmitter<FakeEditor['document']>(),
  configuration: new EventEmitter<unknown>(),
};

/** Makes `editor` the active one, as when the user clicks into a file. */
export function focusEditor(editor: FakeEditor | undefined, fireEvent = true) {
  state.activeTextEditor = editor;
  if (fireEvent) {
    events.activeEditor.fire(editor);
  }
}

export function setWorkspaceFolders(folders: string[]) {
  state.workspaceFolders = folders.map((f, index) => ({ uri: Uri.file(f), name: path.basename(f), index }));
}

export function resetConfig(values: Record<string, unknown> = {}) {
  for (const key of Object.keys(config)) {
    delete config[key];
  }
  Object.assign(config, values);
}

export const vscode = {
  EventEmitter,
  Uri,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { One: 1, Two: 2, Beside: -2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  /** Filled in by the tests that need it: modules see only the keys present when they load. */
  languages: {} as Record<string, unknown>,
  Disposable: class {
    constructor(private readonly fn?: () => void) {}
    dispose() {
      this.fn?.();
    }
    static from(...items: { dispose(): unknown }[]) {
      return { dispose: () => items.forEach((d) => d.dispose()) };
    }
  },
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback?: T) => (key in config ? (config[key] as T) : fallback),
      update: async (key: string, value: unknown) => {
        config[key] = value;
      },
    }),
    get workspaceFolders() {
      return state.workspaceFolders.length ? state.workspaceFolders : undefined;
    },
    getWorkspaceFolder: (uri: FakeUri) =>
      state.workspaceFolders.find((f) => uri.fsPath === f.uri.fsPath || uri.fsPath.startsWith(f.uri.fsPath + path.sep)),
    onDidCloseTextDocument: events.closeDocument.event,
    onDidChangeConfiguration: events.configuration.event,
  },
  window: {
    get activeTextEditor() {
      return state.activeTextEditor;
    },
    onDidChangeActiveTextEditor: events.activeEditor.event,
    onDidChangeTextEditorSelection: events.selection.event,
    createOutputChannel: () => ({ append() {}, appendLine() {}, dispose() {} }),
  },
};

const anyModule = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = anyModule._load;
anyModule._load = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, ...rest);
};

/** In-memory SecretStorage. */
export function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key),
    store: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}
