/**
 * Atom Operations — AI-assisted Split, Merge, and Upgrade for knowledge notes.
 *
 * Uses Copilot API (gpt-4o) to analyze notes and generate actionable suggestions.
 * - Split: Break a large note into focused atoms by heading boundaries
 * - Merge: Combine two highly overlapping notes into one
 * - Upgrade: Enrich an atom with supplementary info from related notes
 */

import { App, TFile, Notice } from 'obsidian';
import type { CopilotCredentials } from './copilot-auth';
import type { KnowledgeEngine } from './knowledge-engine';
import { callCopilot, parseJSON } from './copilot-api';

// ── Types ──

export interface SplitPlan {
  /** Suggested atoms to extract */
  atoms: SplitAtom[];
  /** Whether the original should become a composite (with embeds) */
  makeComposite: boolean;
}

export interface SplitAtom {
  /** Suggested title for the new atom note */
  title: string;
  /** Start line (1-based) */
  startLine: number;
  /** End line (1-based, inclusive) */
  endLine: number;
  /** Optional tags to apply */
  tags: string[];
}

export interface MergePlan {
  /** Suggested title for merged note */
  title: string;
  /** Which content to keep / combine */
  mergedContent: string;
  /** Notes being merged */
  sourceA: string;
  sourceB: string;
}

export interface UpgradeSuggestion {
  /** The atom to upgrade */
  targetPath: string;
  /** Source note with supplementary info */
  sourcePath: string;
  /** What info to add */
  additions: string;
}

// ── Constants ──

const ATOM_OPS_OPTS = {
  model: 'gpt-4o' as const,
  maxTokens: 1024,
  temperature: 0.2,
  maxContentChars: 4000,
};

/** Sanitize a string for use as a filename — remove filesystem-illegal characters */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')  // illegal chars → underscore
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim()
    .slice(0, 100)                     // limit length
    || 'untitled';
}

// ── Split ──

const SPLIT_PROMPT = `You are a knowledge atomization assistant. Analyze this note and suggest how to split it into focused "atom" notes.

Rules:
- Each atom should cover ONE distinct topic/concept
- Use existing heading boundaries (## sections) as natural split points
- Provide start/end line numbers (1-based) for each atom's content
- Suggest a concise title for each atom: "Topic + Focus" format
- If the note has fewer than 3 distinct topics, return empty atoms array
- Tags should be inherited from original note where relevant

Return JSON:
{
  "atoms": [
    { "title": "Atom Title", "startLine": 1, "endLine": 30, "tags": ["tag1"] }
  ],
  "makeComposite": true
}

makeComposite: true if the original note should become a composite that embeds the atoms.
Return valid JSON only, no markdown fences.`;

export async function analyzeSplit(
  app: App,
  filePath: string,
  getCredentials: () => CopilotCredentials | null,
  onRefreshed: (c: CopilotCredentials) => void,
): Promise<SplitPlan | null> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return null;

  const content = await app.vault.read(file);
  const lines = content.split('\n');
  const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');

  try {
    const raw = await callCopilot(getCredentials, onRefreshed, SPLIT_PROMPT, numbered, ATOM_OPS_OPTS);
    const data = parseJSON(raw);

    if (!Array.isArray(data.atoms) || data.atoms.length === 0) return null;

    return {
      atoms: data.atoms
        .filter((a: any) => a.title && a.startLine && a.endLine)
        .map((a: any) => ({
          title: sanitizeFilename(String(a.title)),
          startLine: Math.max(1, Math.min(Number(a.startLine), lines.length)),
          endLine: Math.max(1, Math.min(Number(a.endLine), lines.length)),
          tags: Array.isArray(a.tags) ? a.tags.filter((t: any) => typeof t === 'string') : [],
        })),
      makeComposite: !!data.makeComposite,
    };
  } catch (e) {
    console.warn('[AtomOps] Split analysis failed:', e);
    return null;
  }
}

/**
 * Execute a split plan: create atom files and optionally convert original to composite.
 */
export async function executeSplit(
  app: App,
  filePath: string,
  plan: SplitPlan,
): Promise<string[]> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) return [];

  const content = await app.vault.read(file);
  const lines = content.split('\n');
  const parentFolder = file.parent?.path || '';
  const sourceName = file.basename;

  // Smart subfolder: place atoms in parentFolder/sourceName/
  // unless a folder with that name already exists and contains unrelated files
  const targetFolder = parentFolder ? `${parentFolder}/${sourceName}` : sourceName;

  // Ensure target folder exists
  if (!app.vault.getAbstractFileByPath(targetFolder)) {
    await app.vault.createFolder(targetFolder);
  }

  const createdPaths: string[] = [];

  for (const atom of plan.atoms) {
    const atomLines = lines.slice(atom.startLine - 1, atom.endLine);
    const frontmatter = ['---', 'type: atom'];
    if (atom.tags.length > 0) frontmatter.push(`tags: [${atom.tags.join(', ')}]`);
    frontmatter.push('---', '');

    const atomContent = frontmatter.join('\n') + atomLines.join('\n');
    const atomPath = `${targetFolder}/${atom.title}.md`;

    // Avoid overwriting existing files
    const existing = app.vault.getAbstractFileByPath(atomPath);
    if (existing) {
      new Notice(`Skipped: "${atom.title}" already exists`);
      continue;
    }

    await app.vault.create(atomPath, atomContent);
    createdPaths.push(atomPath);
  }

  // Optionally convert original to composite
  if (plan.makeComposite && createdPaths.length > 0) {
    const embeds = plan.atoms
      .filter((_, i) => i < createdPaths.length)
      .map(a => `![[${a.title}]]`)
      .join('\n\n');

    const compositeFm = '---\ntype: knowledge\n---\n\n';
    const compositeContent = compositeFm + `# ${file.basename}\n\n` + embeds + '\n';
    await app.vault.modify(file, compositeContent);
  }

  // Store rollback info in plugin data directory
  try {
    const rollbackData = {
      timestamp: Date.now(),
      sourcePath: filePath,
      originalContent: content,
      createdPaths,
      targetFolder,
      madeComposite: plan.makeComposite,
    };
    const rollbackPath = `${app.vault.configDir}/plugins/obsidian-antigravity/last-split-rollback.json`;
    await app.vault.adapter.write(rollbackPath, JSON.stringify(rollbackData));
  } catch {
    // Best effort — don't fail the split over rollback persistence
  }

  return createdPaths;
}

// ── Merge ──

const MERGE_PROMPT = `You are a knowledge merge assistant. Two notes have significant content overlap. Analyze them and produce a merged version.

Rules:
- Combine the best/most complete information from both notes
- Remove redundancy but preserve all unique information
- Suggest a clear title for the merged note
- The merged content should be well-structured with headings
- Keep the original language (don't translate)

Return JSON:
{
  "title": "Merged Note Title",
  "mergedContent": "Full markdown content of merged note (no frontmatter)"
}

Return valid JSON only, no markdown fences.`;

export async function analyzeMerge(
  app: App,
  pathA: string,
  pathB: string,
  getCredentials: () => CopilotCredentials | null,
  onRefreshed: (c: CopilotCredentials) => void,
): Promise<MergePlan | null> {
  const fileA = app.vault.getAbstractFileByPath(pathA);
  const fileB = app.vault.getAbstractFileByPath(pathB);
  if (!(fileA instanceof TFile) || !(fileB instanceof TFile)) return null;

  const contentA = await app.vault.read(fileA);
  const contentB = await app.vault.read(fileB);

  const prompt = `--- Note A: ${fileA.basename} ---\n${contentA}\n\n--- Note B: ${fileB.basename} ---\n${contentB}`;

  try {
    const raw = await callCopilot(getCredentials, onRefreshed, MERGE_PROMPT, prompt, ATOM_OPS_OPTS);
    const data = parseJSON(raw);

    if (!data.title || !data.mergedContent) return null;

    return {
      title: sanitizeFilename(String(data.title)),
      mergedContent: String(data.mergedContent),
      sourceA: pathA,
      sourceB: pathB,
    };
  } catch (e) {
    console.warn('[AtomOps] Merge analysis failed:', e);
    return null;
  }
}

/**
 * Execute a merge plan: create merged note and archive originals.
 */
export async function executeMerge(
  app: App,
  plan: MergePlan,
): Promise<string | null> {
  const fileA = app.vault.getAbstractFileByPath(plan.sourceA);
  const fileB = app.vault.getAbstractFileByPath(plan.sourceB);
  if (!(fileA instanceof TFile) || !(fileB instanceof TFile)) return null;

  const folder = fileA.parent?.path || '';
  const mergedPath = folder ? `${folder}/${plan.title}.md` : `${plan.title}.md`;

  // Check for existing file
  if (app.vault.getAbstractFileByPath(mergedPath)) {
    new Notice(`"${plan.title}" already exists`);
    return null;
  }

  const frontmatter = '---\ntype: atom\n---\n\n';
  await app.vault.create(mergedPath, frontmatter + plan.mergedContent);

  // Archive originals by prepending "archived_" prefix
  const archiveA = (fileA.parent?.path || '') + '/archived_' + fileA.name;
  const archiveB = (fileB.parent?.path || '') + '/archived_' + fileB.name;
  await app.vault.rename(fileA, archiveA);
  await app.vault.rename(fileB, archiveB);

  return mergedPath;
}

// ── Upgrade ──

const UPGRADE_PROMPT = `You are a knowledge upgrade assistant. An atom note exists, and a related note contains supplementary information that could enhance it.

Rules:
- Identify what new information from the related note could enrich the atom
- Only suggest additions that are genuinely relevant and not already present
- Format additions as markdown that can be appended to the atom
- Keep the original language
- If no meaningful upgrade is possible, return empty additions

Return JSON:
{
  "additions": "Markdown text to append (or empty string if no upgrade needed)",
  "reason": "Brief explanation of what's being added"
}

Return valid JSON only, no markdown fences.`;

export async function analyzeUpgrade(
  app: App,
  atomPath: string,
  sourcePath: string,
  getCredentials: () => CopilotCredentials | null,
  onRefreshed: (c: CopilotCredentials) => void,
): Promise<UpgradeSuggestion | null> {
  const atomFile = app.vault.getAbstractFileByPath(atomPath);
  const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
  if (!(atomFile instanceof TFile) || !(sourceFile instanceof TFile)) return null;

  const atomContent = await app.vault.read(atomFile);
  const sourceContent = await app.vault.read(sourceFile);

  const prompt = `--- Atom to upgrade: ${atomFile.basename} ---\n${atomContent}\n\n--- Related note with potential info: ${sourceFile.basename} ---\n${sourceContent}`;

  try {
    const raw = await callCopilot(getCredentials, onRefreshed, UPGRADE_PROMPT, prompt, ATOM_OPS_OPTS);
    const data = parseJSON(raw);

    const additions = String(data.additions || '').trim();
    if (!additions) return null;

    return {
      targetPath: atomPath,
      sourcePath,
      additions,
    };
  } catch (e) {
    console.warn('[AtomOps] Upgrade analysis failed:', e);
    return null;
  }
}

/**
 * Execute an upgrade: append additions to the atom note.
 */
export async function executeUpgrade(
  app: App,
  suggestion: UpgradeSuggestion,
): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(suggestion.targetPath);
  if (!(file instanceof TFile)) return false;

  const content = await app.vault.read(file);
  const upgraded = content.trimEnd() + '\n\n' + suggestion.additions + '\n';
  await app.vault.modify(file, upgraded);
  return true;
}
