'use client';

import { useState, useMemo } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/components/locale-provider';
import { formatRelativeTime } from '@/lib/i18n/formatting';
import { 
  FolderKanban, 
  Clock, 
  Workflow, 
  Pause, 
  CheckCircle2, 
  RotateCw, 
  AlertTriangle, 
  XCircle, 
  Plus, 
  Pencil, 
  Trash2, 
  Archive, 
  Play, 
  RotateCcw,
  SkipForward
} from 'lucide-react';
import { cn } from '@/lib/utils';
import ProjectWorkbench from '@/components/project-workbench';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { 
  AgentRun, 
  Project, 
  ModelConfig, 
  TemplateSummaryFE, 
  ResumeAction 
} from '@/lib/types';

interface ProjectsPanelProps {
  projects: Project[];
  agentRuns: AgentRun[];
  onSelectProject?: (projectId: string) => void;
  onSelectRun?: (runId: string) => void;
  selectedProjectId?: string | null;
  /** Template definitions for resolving stage names */
  templates?: TemplateSummaryFE[];
  /** Available model configurations */
  models?: ModelConfig[];
  /** Callback to resume a failed pipeline stage */
  onResume?: (projectId: string, stageIndex: number, action: ResumeAction) => Promise<void>;
  /** Callback to cancel a run */
  onCancelRun?: (runId: string) => void;
  /** Callback to open a conversation */
  onOpenConversation?: (id: string, title: string) => void;
  onRefresh?: () => void;
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const config = {
    active: { color: 'text-sky-400', bg: 'bg-sky-400/10', border: 'border-sky-400/20', icon: RotateCw },
    completed: { color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/20', icon: CheckCircle2 },
    failed: { color: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-400/20', icon: AlertTriangle },
    cancelled: { color: 'text-slate-300', bg: 'bg-slate-400/10', border: 'border-slate-400/20', icon: XCircle },
    paused: { color: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/20', icon: Pause },
    archived: { color: 'text-slate-400', bg: 'bg-slate-400/10', border: 'border-slate-400/20', icon: Clock },
    skipped: { color: 'text-slate-400', bg: 'bg-slate-400/10', border: 'border-slate-400/20', icon: SkipForward },
  }[status] || { color: 'text-slate-400', bg: 'bg-slate-400/10', border: 'border-slate-400/20', icon: Clock };

  const Icon = config.icon;
  // Use status title from i18n
  const label = t(`projects.status.${status as any}` as any) || status;

  return (
    <div className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium', config.bg, config.color, config.border)}>
      <Icon className={cn("h-3.5 w-3.5", config.color, status === 'active' && 'animate-spin-slow')} />
      <span className={config.color}>{label}</span>
    </div>
  );
}

export default function ProjectsPanel({
  projects,
  agentRuns,
  onSelectProject,
  selectedProjectId,
  templates,
  models,
  onRefresh,
  onResume,
  onCancelRun,
  onOpenConversation,
}: ProjectsPanelProps) {
  const { t, locale } = useI18n();

  const handleEvaluateRun = async (runId: string) => {
    await api.interveneRun(runId, { action: 'evaluate' });
    onRefresh?.();
  };

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDispatchDialogOpen, setIsDispatchDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [dispatchingProject, setDispatchingProject] = useState<Project | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    goal: '',
    templateId: '',
  });

  const [dispatchData, setDispatchData] = useState({
    templateId: '',
    prompt: '',
  });

  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sort projects by newest first
  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [projects]);

  const handleCreate = async () => {
    setIsSubmitting(true);
    try {
      await api.createProject(formData);
      setIsCreateDialogOpen(false);
      onRefresh?.();
    } catch (err) {
      console.error('Failed to create project:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingProject) return;
    setIsSubmitting(true);
    try {
      await api.updateProject(editingProject.projectId, {
        name: formData.name,
        goal: formData.goal,
      });
      setIsEditDialogOpen(false);
      setEditingProject(null);
      onRefresh?.();
    } catch (err) {
      console.error('Failed to update project:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm(t('projects.deleteConfirm'))) return;
    try {
      await api.deleteProject(id);
      onRefresh?.();
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  };

  const handleArchive = async (e: React.MouseEvent, id: string, archived: boolean) => {
    e.stopPropagation();
    if (archived && !confirm(t('projects.archiveConfirm'))) return;
    try {
      await api.updateProject(id, { status: archived ? 'archived' : 'active' });
      onRefresh?.();
    } catch (err) {
      console.error('Failed to update project status:', err);
    }
  };

  const handleDispatch = async () => {
    if (!dispatchingProject) return;
    setIsSubmitting(true);
    try {
      await api.dispatchRun({
        projectId: dispatchingProject.projectId,
        templateId: dispatchData.templateId,
        workspace: dispatchingProject.workspace,
        prompt: dispatchData.prompt,
      });
      setIsDispatchDialogOpen(false);
      onRefresh?.();
    } catch (err) {
      console.error('Failed to dispatch pipeline:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openCreateDialog = () => {
    setFormData({
      name: '',
      goal: '',
      templateId: '',
    });
    setIsCreateDialogOpen(true);
  };

  const openEditDialog = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    setEditingProject(project);
    setFormData({
      name: project.name,
      goal: project.goal,
      templateId: project.templateId || '',
    });
    setIsEditDialogOpen(true);
  };

  const openDispatchDialog = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation();
    setDispatchingProject(project);
    setDispatchData({
      templateId: project.templateId || templates?.[0]?.id || '',
      prompt: project.goal || '',
    });
    setIsDispatchDialogOpen(true);
  };

  return (
    <>
      {sortedProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-[24px] border border-dashed border-white/10 bg-white/[0.02] py-20 text-center">
          <FolderKanban className="mb-4 h-12 w-12 text-white/20" />
          <h3 className="text-lg font-medium text-white/80">{t('projects.noProjects')}</h3>
          <p className="mt-2 text-sm text-[var(--app-text-soft)]">
            {t('projects.createPrompt')}
          </p>
          <Button onClick={openCreateDialog} className="mt-6 gap-2 rounded-full">
            <Plus className="h-4 w-4" />
            {t('projects.createProject')}
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-white">{t('projects.title')}</h2>
            <Button onClick={openCreateDialog} className="gap-2 rounded-full">
              <Plus className="h-4 w-4" />
              {t('projects.createProject')}
            </Button>
          </div>

          {sortedProjects.map((project) => {
            const projectRuns = agentRuns.filter(run => 
              run.projectId === project.projectId || project.runIds?.includes(run.runId)
            ).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

            const isSelected = selectedProjectId === project.projectId;

            return (
              <div
                key={project.projectId}
                className={cn(
                  "group relative overflow-hidden rounded-[24px] border transition-all duration-300",
                  isSelected
                    ? "border-emerald-500/30 bg-[linear-gradient(180deg,rgba(16,35,46,0.95),rgba(11,21,30,0.98))] shadow-[0_12px_40px_rgba(0,180,140,0.15)]"
                    : "border-white/6 bg-[linear-gradient(180deg,rgba(18,25,35,0.6),rgba(12,18,26,0.8))] hover:border-white/10 hover:bg-[linear-gradient(180deg,rgba(22,32,45,0.7),rgba(14,21,30,0.9))] shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
                )}
                onClick={() => onSelectProject?.(project.projectId)}
              >
                {/* Soft Glow */}
                <div className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                  <div className="absolute -left-20 -top-20 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(50,200,255,0.06),transparent_70%)] blur-3xl" />
                  <div className="absolute -bottom-20 -right-20 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(50,255,150,0.06),transparent_70%)] blur-3xl" />
                </div>

                <div className="relative p-6 px-7">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/[0.04] border border-white/10 text-white/80 shadow-inner">
                          <FolderKanban className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="text-xl font-semibold tracking-tight text-white">{project.name}</h3>
                          <div className="mt-1 flex items-center gap-3 text-sm text-[var(--app-text-muted)]">
                            <div className="flex items-center gap-1">
                              <Clock className="h-3.5 w-3.5" />
                              <span>{formatRelativeTime(project.createdAt, locale)}</span>
                            </div>
                            {project.templateId && (
                              <div className="flex items-center gap-1">
                                <Workflow className="h-3.5 w-3.5" />
                                <span>{project.templateId}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      <p className="mt-4 text-[15px] leading-relaxed text-[var(--app-text-soft)] max-w-3xl">
                        {project.goal}
                      </p>
                    </div>
                    
                    <div className="flex flex-col items-end gap-3">
                      <StatusBadge status={project.status} />
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {!project.pipelineState && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-sky-400 hover:bg-sky-400/10 hover:text-sky-300"
                            onClick={(e) => openDispatchDialog(e, project)}
                            title={t('projects.dispatchPipeline')}
                          >
                            <Play className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-white/60 hover:bg-white/10 hover:text-white"
                          onClick={(e) => openEditDialog(e, project)}
                          title={t('projects.editProject')}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn(
                            "h-8 w-8",
                            project.status === 'archived' ? "text-amber-400 hover:bg-amber-400/10" : "text-slate-400 hover:bg-slate-400/10"
                          )}
                          onClick={(e) => handleArchive(e, project.projectId, project.status !== 'archived')}
                          title={project.status === 'archived' ? t('projects.unarchiveProject') : t('projects.archiveProject')}
                        >
                          {project.status === 'archived' ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-400 hover:bg-red-400/10 hover:text-red-300"
                          onClick={(e) => handleDelete(e, project.projectId)}
                          title={t('projects.deleteProject')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-8">
                    {project.pipelineState && isSelected ? (
                      (() => {
                        const templateId = project.pipelineState?.templateId || project.templateId || '';
                        const template = templates?.find(t => t.id === templateId);
                        const templateGroups = template?.groups || {};

                        return (
                          <ProjectWorkbench
                            project={project}
                            agentRuns={agentRuns}
                            templateGroups={templateGroups}
                            models={models || []}
                            onResume={onResume || (async () => {})}
                            onCancelRun={onCancelRun || (() => {})}
                            onOpenConversation={onOpenConversation}
                            onEvaluateRun={handleEvaluateRun}
                          />
                        );
                      })()
                    ) : project.pipelineState ? (
                      (() => {
                        const pStages = project.pipelineState.stages;
                        const completed = pStages.filter(s => s.status === 'completed' || s.status === 'skipped').length;
                        const total = pStages.length;
                        const templateId = project.pipelineState?.templateId || project.templateId || '';
                        const template = templates?.find(t => t.id === templateId);
                        const templateGroups = template?.groups || {};

                        return (
                          <div className="space-y-2">
                            <h4 className="text-xs font-semibold uppercase tracking-widest text-[var(--app-text-muted)]">
                              Pipeline Progress · {completed}/{total}
                            </h4>
                            <div className="flex items-center gap-1.5">
                              {pStages.map((s) => {
                                const stageTitle = templateGroups?.[s.groupId]?.title || s.groupId;
                                return (
                                  <div
                                    key={s.stageIndex}
                                    title={`${stageTitle}: ${s.status}`}
                                    className={cn(
                                      'h-2 flex-1 rounded-full transition-colors',
                                      s.status === 'completed' ? 'bg-emerald-400/60' :
                                      s.status === 'running' ? 'bg-sky-400/60 animate-pulse' :
                                      s.status === 'blocked' ? 'bg-amber-400/60' :
                                      s.status === 'failed' ? 'bg-red-400/60' :
                                      s.status === 'cancelled' ? 'bg-slate-300/50' :
                                      s.status === 'skipped' ? 'bg-slate-400/40' :
                                      'bg-white/10',
                                    )}
                                  />
                                );
                              })}
                            </div>
                            <div className="flex flex-wrap gap-2 mt-1">
                              {pStages.map((s) => {
                                const stageTitle = templateGroups?.[s.groupId]?.title || s.groupId;
                                return (
                                  <span
                                    key={s.stageIndex}
                                    className={cn(
                                      'text-[10px] font-medium px-2 py-0.5 rounded-full',
                                      s.status === 'completed' ? 'bg-emerald-500/10 text-emerald-400/80' :
                                      s.status === 'running' ? 'bg-sky-500/10 text-sky-400/80' :
                                      s.status === 'blocked' ? 'bg-amber-500/10 text-amber-400/80' :
                                      s.status === 'failed' ? 'bg-red-500/10 text-red-400/80' :
                                      s.status === 'cancelled' ? 'bg-slate-500/10 text-slate-300/80' :
                                      s.status === 'skipped' ? 'bg-slate-500/10 text-slate-400/80' :
                                      'bg-white/5 text-white/30',
                                    )}
                                  >
                                    {stageTitle}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()
                    ) : projectRuns.length > 0 ? (
                      <div className="text-sm text-[var(--app-text-soft)]">
                        {projectRuns.length} agent run{projectRuns.length !== 1 ? 's' : ''}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-[var(--app-text-soft)]">
                        No agents have been dispatched for this project yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Shared Dialogs */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('projects.createProject')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--app-text-soft)]">{t('projects.projectName')}</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. My Website Redesign"
                className="bg-white/5"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--app-text-soft)]">{t('projects.projectGoal')}</label>
              <Textarea
                value={formData.goal}
                onChange={(e) => setFormData({ ...formData, goal: e.target.value })}
                placeholder="What are we building?"
                className="bg-white/5 min-h-[100px]"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--app-text-soft)]">{t('projects.selectTemplate')} (Optional)</label>
              <Select
                value={formData.templateId || 'none'}
                onValueChange={(v) => v && setFormData({ ...formData, templateId: v === 'none' ? '' : v })}
              >
                <SelectTrigger className="bg-white/5">
                  <SelectValue placeholder="No template" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No template</SelectItem>
                  {templates?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsCreateDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleCreate} disabled={isSubmitting || !formData.name || !formData.goal}>
              {isSubmitting ? t('common.loading') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('projects.editProject')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--app-text-soft)]">{t('projects.projectName')}</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="bg-white/5"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--app-text-soft)]">{t('projects.projectGoal')}</label>
              <Textarea
                value={formData.goal}
                onChange={(e) => setFormData({ ...formData, goal: e.target.value })}
                className="bg-white/5 min-h-[100px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsEditDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleUpdate} disabled={isSubmitting || !formData.name || !formData.goal}>
              {isSubmitting ? t('common.loading') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isDispatchDialogOpen} onOpenChange={setIsDispatchDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('projects.dispatchPipeline')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--app-text-soft)]">{t('projects.selectTemplate')}</label>
              <Select
                value={dispatchData.templateId || ''}
                onValueChange={(v) => v && setDispatchData({ ...dispatchData, templateId: v })}
              >
                <SelectTrigger className="bg-white/5">
                  <SelectValue placeholder="Select template" />
                </SelectTrigger>
                <SelectContent>
                  {templates?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--app-text-soft)]">{t('projects.pipelineGoal')}</label>
              <Textarea
                value={dispatchData.prompt}
                onChange={(e) => setDispatchData({ ...dispatchData, prompt: e.target.value })}
                placeholder="What should this pipeline achieve?"
                className="bg-white/5 min-h-[120px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsDispatchDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleDispatch} disabled={isSubmitting || !dispatchData.templateId || !dispatchData.prompt}>
              {isSubmitting ? t('common.loading') : t('projects.startPipeline')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
