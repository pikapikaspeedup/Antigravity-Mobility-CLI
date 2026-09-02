import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { getConversations } from './statedb';

const PROJECTS_DIR = path.join(homedir(), '.gemini/config/projects');

export interface AgyProjectFolder {
  uri: string;
  path: string;
  allowWrite: boolean;
  kind: 'git' | 'folder';
}

export interface AgyProject {
  id: string;
  name: string;
  folders: AgyProjectFolder[];
}

function toPath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

function parseResource(resource: any): AgyProjectFolder | null {
  if (resource?.gitFolder?.folderUri) {
    return {
      uri: resource.gitFolder.folderUri,
      path: toPath(resource.gitFolder.folderUri),
      allowWrite: resource.gitFolder.allowWrite !== false,
      kind: 'git',
    };
  }
  const uri = resource?.folderUri || resource?.folder?.folderUri;
  if (!uri) return null;
  return {
    uri,
    path: toPath(uri),
    allowWrite: resource.allowWrite === true || resource?.folder?.allowWrite === true,
    kind: 'folder',
  };
}

function parseProjectFile(raw: any): AgyProject | null {
  const id = raw?.id;
  const name = raw?.name;
  if (!id || !name) return null;
  const folders: AgyProjectFolder[] = [];
  const seen = new Set<string>();
  for (const resource of raw?.projectResources?.resources || []) {
    const folder = parseResource(resource);
    if (!folder || seen.has(folder.uri)) continue;
    seen.add(folder.uri);
    folders.push(folder);
  }
  return { id, name, folders };
}

export function listAgyProjects(): AgyProject[] {
  try {
    const projects: AgyProject[] = [];
    for (const name of readdirSync(PROJECTS_DIR)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      try {
        const parsed = parseProjectFile(JSON.parse(readFileSync(path.join(PROJECTS_DIR, name), 'utf-8')));
        if (parsed) projects.push(parsed);
      } catch { /* skip malformed */ }
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getAgyProject(id: string): AgyProject | null {
  return listAgyProjects().find(p => p.id === id) || null;
}

export function findAgyProjectByFolder(uriOrPath: string): AgyProject | null {
  const needle = toPath(uriOrPath);
  if (!needle) return null;
  for (const project of listAgyProjects()) {
    if (project.folders.some(folder => toPath(folder.uri) === needle || needle.startsWith(toPath(folder.uri) + '/'))) {
      return project;
    }
  }
  return null;
}

export function projectFolderUris(project: AgyProject): string[] {
  return project.folders.map(folder => folder.uri);
}

export function primaryWritePath(project: AgyProject): string {
  const writable = project.folders.find(folder => folder.allowWrite) || project.folders[0];
  return writable?.path || '';
}

export function normalizeFolderPath(input: string): string {
  const trimmed = input.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) return '';
  if (trimmed.startsWith('file://')) return path.resolve(trimmed.slice('file://'.length));
  return path.resolve(trimmed.replace(/^~(?=\/|$)/, homedir()));
}

export function uniqueProjectName(base: string): string {
  const existing = new Set(listAgyProjects().map(p => p.name));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

export function buildCreateProjectBody(folderPath: string, name?: string): { id: string; name: string; projectResources: unknown } | { error: string } {
  const abs = normalizeFolderPath(folderPath);
  if (!abs) return { error: 'Folder path is required' };
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    return { error: `Not a directory: ${abs}` };
  }
  const uri = `file://${abs}`;
  // Official writable roots are stored as gitFolder even for ordinary directories.
  const resource = { gitFolder: { folderUri: uri, allowWrite: true } };
  return {
    id: randomUUID(),
    name: uniqueProjectName(name?.trim() || path.basename(abs)),
    projectResources: { resources: [resource] },
  };
}

export function resolveConversationFolders(cascadeId: string): string[] {
  try {
    const local = getConversations().find(c => c.id === cascadeId);
    const project = local?.projectId
      ? getAgyProject(local.projectId)
      : (local?.workspace ? findAgyProjectByFolder(local.workspace) : null);
    if (project?.folders.length) return project.folders.map(folder => folder.path);
    if (local?.workspace) return [toPath(local.workspace)];
  } catch { /* ignore */ }
  return [process.cwd()];
}
