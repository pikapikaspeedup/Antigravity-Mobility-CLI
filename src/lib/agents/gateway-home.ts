/**
 * Unified Gateway data root path.
 * 
 * All registries (projects, runs, conversations) and global assets
 * are stored under this directory. Supports AG_GATEWAY_HOME env override.
 * 
 * On first run, assets (templates, workflows, review-policies) are synced
 * from the repo's .agents/ directory to the global assets directory.
 */

import { homedir } from 'os';
import path from 'path';
import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs';

const DEFAULT_HOME = path.join(homedir(), '.gemini', 'antigravity', 'gateway');

export const GATEWAY_HOME = process.env.AG_GATEWAY_HOME || DEFAULT_HOME;

/** Default working root for agent artifacts when no workspace is selected. */
export function defaultWorkUri(): string {
  return `file://${GATEWAY_HOME}`;
}

if (!existsSync(GATEWAY_HOME)) {
  mkdirSync(GATEWAY_HOME, { recursive: true });
}

// Registry files
export const PROJECTS_FILE = path.join(GATEWAY_HOME, 'projects.json');
export const RUNS_FILE = path.join(GATEWAY_HOME, 'agent_runs.json');
export const CONVS_FILE = path.join(GATEWAY_HOME, 'local_conversations.json');
export const HIDDEN_WS_FILE = path.join(GATEWAY_HOME, 'hidden_workspaces.json');

// Global assets directory
export const GLOBAL_ASSETS_DIR = path.join(GATEWAY_HOME, 'assets');

// Per-workspace artifact directory name (relative to workspace root)
export const ARTIFACT_ROOT_DIR = 'demolong';

/**
 * Sync repo assets to global directory on startup.
 * Uses cp -n semantics (skip existing files, never overwrite).
 */
function syncAssetsToGlobal(): void {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const dirs = [
    { src: path.join(repoRoot, '.agents', 'assets', 'templates'), dest: path.join(GLOBAL_ASSETS_DIR, 'templates'), ext: '.json' },
    { src: path.join(repoRoot, '.agents', 'assets', 'review-policies'), dest: path.join(GLOBAL_ASSETS_DIR, 'review-policies'), ext: '.json' },
    { src: path.join(repoRoot, '.agents', 'workflows'), dest: path.join(GLOBAL_ASSETS_DIR, 'workflows'), ext: '.md' },
  ];

  for (const { src, dest, ext } of dirs) {
    if (!existsSync(src)) continue;
    mkdirSync(dest, { recursive: true });
    for (const file of readdirSync(src)) {
      if (!file.endsWith(ext)) continue;
      const target = path.join(dest, file);
      if (!existsSync(target)) {
        copyFileSync(path.join(src, file), target);
      }
    }
  }
}

syncAssetsToGlobal();
