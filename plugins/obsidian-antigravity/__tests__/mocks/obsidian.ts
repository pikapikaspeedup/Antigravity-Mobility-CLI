/**
 * Minimal Obsidian API mock for unit testing.
 * Only stubs functions/classes used by the tested modules.
 */

export class TFile {
  path: string;
  basename: string;
  extension: string;
  name: string;
  stat: { mtime: number };
  parent: { path: string } | null;

  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() || path;
    this.basename = this.name.replace(/\.md$/, '');
    this.extension = 'md';
    this.stat = { mtime: Date.now() };
    this.parent = path.includes('/') ? { path: path.split('/').slice(0, -1).join('/') } : null;
  }
}

export class Notice {
  constructor(public message: string) {}
}

export function debounce<T extends (...args: any[]) => any>(fn: T, delay: number, _immediate?: boolean): T {
  return fn; // no-op for tests — execute immediately
}

export function setIcon(_el: HTMLElement, _name: string) {}

export function requestUrl(_opts: any): Promise<any> {
  return Promise.resolve({ json: {} });
}

export class App {
  vault: any;
  metadataCache: any;
  workspace: any;
}

export class ItemView {
  containerEl: any = { children: [null, { empty: () => {}, addClass: () => {}, createDiv: () => ({}) }] };
  app: any;
  leaf: any;
  constructor(_leaf: any) { this.leaf = _leaf; }
  getViewType() { return ''; }
  getDisplayText() { return ''; }
  getIcon() { return ''; }
  async onOpen() {}
  async onClose() {}
}

export class WorkspaceLeaf {}

export class MarkdownView {
  editor: any;
  file: TFile | null = null;
}

export class MetadataCache {}
export class CachedMetadata {}
