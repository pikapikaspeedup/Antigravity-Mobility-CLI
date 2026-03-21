'use client';

import { useState, useEffect, useCallback } from 'react';
import type { KnowledgeItem, KnowledgeDetail } from '@/lib/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { marked } from 'marked';
import {
  BookOpen, ChevronLeft, FileText, Trash2, Save, X, Clock,
  Link2, MessageSquare, FolderOpen, Loader2, Check, AlertTriangle,
  Pencil, Eye, ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

interface KnowledgePanelProps {
  open: boolean;
  onClose: () => void;
}

function renderMarkdown(text: string): string {
  try { return marked.parse(text, { async: false }) as string; }
  catch { return text; }
}

function timeAgo(dateStr: string): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function refIcon(type: string) {
  if (type === 'workspace') return <FolderOpen className="w-3.5 h-3.5 shrink-0 text-blue-400" />;
  if (type === 'conversation_id') return <MessageSquare className="w-3.5 h-3.5 shrink-0 text-indigo-400" />;
  if (type === 'url') return <Link2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" />;
  return <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />;
}

export default function KnowledgePanel({ open, onClose }: KnowledgePanelProps) {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Current artifact being viewed/edited in the main panel
  const [activeArtifact, setActiveArtifact] = useState<string | null>(null);

  // Edit mode for artifact
  const [editMode, setEditMode] = useState(false);
  const [artifactDraft, setArtifactDraft] = useState('');

  // Metadata editing
  const [editingMeta, setEditingMeta] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [summaryDraft, setSummaryDraft] = useState('');

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try { setItems(await api.knowledge()); } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) { loadItems(); setSelectedId(null); setDetail(null); setActiveArtifact(null); }
  }, [open, loadItems]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetail(null);
    setActiveArtifact(null);
    setEditMode(false);
    setEditingMeta(false);
    setSaveMsg('');
    try {
      const data = await api.knowledgeDetail(id);
      setDetail(data);
      // Auto-select first artifact
      if (data.artifactFiles.length > 0) {
        setActiveArtifact(data.artifactFiles[0]);
      }
    } catch { /* silent */ }
    setDetailLoading(false);
  }, []);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    loadDetail(id);
  };

  const handleBack = () => {
    setSelectedId(null);
    setDetail(null);
    setActiveArtifact(null);
    setEditMode(false);
    setEditingMeta(false);
  };

  const handleSaveMeta = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      await api.updateKnowledge(detail.id, { title: titleDraft, summary: summaryDraft });
      setDetail({ ...detail, title: titleDraft, summary: summaryDraft });
      setEditingMeta(false);
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2000);
      loadItems();
    } catch { setSaveMsg('Failed'); }
    setSaving(false);
  };

  const handleSaveArtifact = async () => {
    if (!detail || !activeArtifact) return;
    setSaving(true);
    try {
      await api.updateKnowledgeArtifact(detail.id, activeArtifact, artifactDraft);
      setDetail({ ...detail, artifacts: { ...detail.artifacts, [activeArtifact]: artifactDraft } });
      setEditMode(false);
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch { setSaveMsg('Failed'); }
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteKnowledge(deleteTarget.id);
      setDeleteTarget(null);
      if (selectedId === deleteTarget.id) handleBack();
      loadItems();
    } catch { /* silent */ }
    setDeleting(false);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-background flex">
      {/* ══════ LEFT SIDEBAR ══════ */}
      <aside className={cn(
        'flex flex-col border-r bg-background shrink-0 h-full overflow-hidden',
        // On mobile: full width when no artifact selected, hidden when viewing
        selectedId && activeArtifact ? 'hidden md:flex md:w-[300px]' : 'w-full md:w-[300px]',
      )}>
        {/* Sidebar Header */}
        <div className="flex items-center gap-3 px-4 h-14 border-b shrink-0">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={selectedId ? handleBack : onClose}>
            {selectedId ? <ChevronLeft className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </Button>
          <BookOpen className="h-4 w-4 text-indigo-500 shrink-0" />
          <h2 className="text-sm font-semibold flex-1 truncate">
            {selectedId ? 'Knowledge Detail' : 'Knowledge Items'}
          </h2>
          {saveMsg && (
            <Badge variant="outline" className="text-[10px] h-5 text-emerald-500 border-emerald-500/30">
              <Check className="h-3 w-3 mr-1" />{saveMsg}
            </Badge>
          )}
          {!selectedId && <Badge variant="secondary" className="text-[10px] h-5 font-mono">{items.length}</Badge>}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {!selectedId ? (
            /* ── KI List ── */
            <div className="p-3 space-y-2">
              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : items.length === 0 ? (
                <div className="text-center py-20 text-muted-foreground text-sm">No knowledge items</div>
              ) : items.map(item => (
                <button
                  key={item.id}
                  className="w-full text-left p-3 rounded-lg border bg-card hover:bg-accent/50 transition-all group space-y-1.5"
                  onClick={() => handleSelect(item.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-xs font-semibold leading-tight group-hover:text-primary transition-colors line-clamp-2">
                      {item.title}
                    </h3>
                    <Button
                      variant="ghost" size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                      onClick={e => { e.stopPropagation(); setDeleteTarget(item); }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">{item.summary}</p>
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                    <span className="flex items-center gap-1"><FileText className="h-2.5 w-2.5" />{item.artifactFiles.length}</span>
                    <span className="flex items-center gap-1"><Clock className="h-2.5 w-2.5" />{timeAgo(item.timestamps.accessed)}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : detailLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : detail ? (
            /* ── KI Detail Sidebar ── */
            <div className="p-3 space-y-4">
              {/* Metadata Card */}
              <div className="rounded-lg border bg-card p-3 space-y-3">
                {editingMeta ? (
                  <div className="space-y-3">
                    <div>
                      <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Title</label>
                      <input
                        className="w-full text-xs font-semibold bg-muted/50 border rounded-md px-2.5 py-1.5 mt-1 focus:outline-none focus:ring-2 focus:ring-primary/30"
                        value={titleDraft}
                        onChange={e => setTitleDraft(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Summary</label>
                      <textarea
                        className="w-full text-[11px] bg-muted/50 border rounded-md px-2.5 py-1.5 mt-1 focus:outline-none focus:ring-2 focus:ring-primary/30 min-h-[80px] resize-y leading-relaxed"
                        value={summaryDraft}
                        onChange={e => setSummaryDraft(e.target.value)}
                      />
                    </div>
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingMeta(false)}>Cancel</Button>
                      <Button size="sm" className="h-7 text-xs" onClick={handleSaveMeta} disabled={saving}>
                        {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Save className="h-3 w-3 mr-1" />}Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="cursor-pointer hover:bg-muted/30 rounded-md p-1 -m-1 transition-colors group/meta"
                    onClick={() => { setTitleDraft(detail.title); setSummaryDraft(detail.summary); setEditingMeta(true); }}
                  >
                    <div className="flex items-start justify-between">
                      <h3 className="text-xs font-bold leading-tight">{detail.title}</h3>
                      <Pencil className="h-3 w-3 text-muted-foreground/40 opacity-0 group-hover/meta:opacity-100 transition-opacity shrink-0 mt-0.5" />
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed mt-1.5 line-clamp-4">{detail.summary}</p>
                  </div>
                )}
              </div>

              {/* Timestamps */}
              <div className="grid grid-cols-3 gap-1.5 text-[9px] text-muted-foreground/60">
                <div className="bg-muted/20 rounded px-2 py-1.5 text-center">
                  <div className="font-bold uppercase">Created</div>
                  <div>{timeAgo(detail.timestamps.created)}</div>
                </div>
                <div className="bg-muted/20 rounded px-2 py-1.5 text-center">
                  <div className="font-bold uppercase">Modified</div>
                  <div>{timeAgo(detail.timestamps.modified)}</div>
                </div>
                <div className="bg-muted/20 rounded px-2 py-1.5 text-center">
                  <div className="font-bold uppercase">Accessed</div>
                  <div>{timeAgo(detail.timestamps.accessed)}</div>
                </div>
              </div>

              {/* References */}
              {detail.references.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">References</label>
                  {detail.references.map((ref, i) => (
                    <div key={i} className="flex items-center gap-2 text-[10px] bg-muted/20 rounded-md px-2.5 py-1.5">
                      {refIcon(ref.type)}
                      <span className="truncate text-muted-foreground font-mono">{ref.value}</span>
                    </div>
                  ))}
                </div>
              )}

              <Separator />

              {/* Artifact Files List */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                  Artifacts ({detail.artifactFiles.length})
                </label>
                {detail.artifactFiles.map(f => (
                  <button
                    key={f}
                    className={cn(
                      'w-full flex items-center gap-2 text-left p-2.5 rounded-lg border transition-all text-[11px]',
                      activeArtifact === f
                        ? 'bg-primary/10 border-primary/30 text-primary font-semibold'
                        : 'bg-card hover:bg-accent/50 text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => { setActiveArtifact(f); setEditMode(false); }}
                  >
                    <FileText className={cn('h-3.5 w-3.5 shrink-0', activeArtifact === f ? 'text-primary' : 'text-amber-500')} />
                    <span className="truncate flex-1">{f}</span>
                    <Badge variant="outline" className="text-[8px] h-4 px-1 opacity-40">
                      {((detail.artifacts[f]?.length || 0) / 1024).toFixed(1)}k
                    </Badge>
                  </button>
                ))}
              </div>

              <Separator />

              {/* Danger */}
              <Button
                variant="outline" size="sm"
                className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 text-xs h-8"
                onClick={() => setDeleteTarget(detail)}
              >
                <Trash2 className="h-3 w-3 mr-1.5" />Delete Knowledge Item
              </Button>
            </div>
          ) : null}
        </div>
      </aside>

      {/* ══════ MAIN CONTENT AREA ══════ */}
      <main className={cn(
        'flex-1 flex flex-col min-w-0',
        // On mobile: hidden when no artifact selected (sidebar is full)
        !selectedId || !activeArtifact ? 'hidden md:flex' : 'flex',
      )}>
        {!selectedId || !detail ? (
          /* ── Empty State ── */
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-6">
              <BookOpen className="w-8 h-8 text-indigo-500" />
            </div>
            <h2 className="text-xl font-bold tracking-tight mb-2">Knowledge Base</h2>
            <p className="text-muted-foreground text-sm max-w-sm leading-relaxed">
              Select a knowledge item from the sidebar to view and edit its artifacts.
            </p>
          </div>
        ) : !activeArtifact ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <FileText className="w-10 h-10 text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground text-sm">Select an artifact file to view</p>
          </div>
        ) : (
          <>
            {/* Artifact Header */}
            <div className="flex items-center gap-3 px-4 md:px-6 h-12 border-b shrink-0 bg-background/95 backdrop-blur">
              {/* Mobile: back button */}
              <Button
                variant="ghost" size="icon" className="h-8 w-8 md:hidden shrink-0"
                onClick={() => setActiveArtifact(null)}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <FileText className="h-4 w-4 text-amber-500 shrink-0" />
              <span className="text-sm font-medium truncate flex-1 font-mono">{activeArtifact}</span>

              {/* View/Edit toggle */}
              <div className="flex items-center border rounded-lg overflow-hidden h-8">
                <button
                  className={cn('px-3 h-full text-xs font-medium flex items-center gap-1.5 transition-colors',
                    !editMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                  onClick={() => setEditMode(false)}
                >
                  <Eye className="h-3 w-3" />Preview
                </button>
                <button
                  className={cn('px-3 h-full text-xs font-medium flex items-center gap-1.5 transition-colors border-l',
                    editMode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}
                  onClick={() => { setArtifactDraft(detail.artifacts[activeArtifact] || ''); setEditMode(true); }}
                >
                  <Pencil className="h-3 w-3" />Edit
                </button>
              </div>

              {editMode && (
                <Button size="sm" className="h-8 text-xs" onClick={handleSaveArtifact} disabled={saving}>
                  {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : <Save className="h-3 w-3 mr-1.5" />}
                  Save
                </Button>
              )}
            </div>

            {/* Artifact Content */}
            {editMode ? (
              /* ── Split Editor (desktop: side-by-side, mobile: tabs) ── */
              <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                {/* Editor */}
                <div className="flex-1 flex flex-col min-w-0 border-r">
                  <div className="px-3 py-1.5 border-b bg-muted/20 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    Markdown Source
                  </div>
                  <textarea
                    className="flex-1 w-full p-4 font-mono text-sm bg-background resize-none focus:outline-none leading-relaxed overflow-auto"
                    value={artifactDraft}
                    onChange={e => setArtifactDraft(e.target.value)}
                    spellCheck={false}
                    autoFocus
                  />
                </div>
                {/* Live Preview (desktop only) */}
                <div className="hidden md:flex flex-1 flex-col min-w-0">
                  <div className="px-3 py-1.5 border-b bg-muted/20 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                    Preview
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <div className="p-6 md:p-10 max-w-3xl mx-auto">
                      <div
                        className="chat-markdown text-[15px] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(artifactDraft) }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* ── Rendered Markdown View ── */
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="p-6 md:p-10 lg:p-16 max-w-3xl mx-auto">
                  <div
                    className="chat-markdown text-[15px] leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.artifacts[activeArtifact] || '') }}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />Delete Knowledge Item
            </DialogTitle>
            <DialogDescription>
              Permanently delete <strong>{deleteTarget?.title}</strong> and all artifacts. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Trash2 className="h-4 w-4 mr-1.5" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
