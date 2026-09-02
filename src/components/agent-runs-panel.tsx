'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '@/components/locale-provider';
import type { AgentRun, HubProject, ModelConfig } from '@/lib/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Bot, XCircle, Clock, CheckCircle2, AlertCircle, Ban, Loader2, ChevronDown, ChevronUp, Send, RefreshCw, Sparkles, Zap, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getAgentRunDuration, getAgentRunTimeAgo, getAgentRunWorkspaceName, isAgentRunActive } from '@/lib/agent-run-utils';

interface AgentRunsPanelProps {
  currentModel: string;
  models?: ModelConfig[];
  currentModelLabel?: string;
  layout?: 'compact' | 'full';
  showRunsList?: boolean;
  onDispatched?: (runId: string) => void | Promise<void>;
}

type RunModelMode = 'follow-header' | 'group-default' | 'explicit';

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const statusConfig: Record<string, { icon: React.ReactNode; color: string; rail: string; surface: string }> = {
  queued: {
    icon: <Clock className="w-3.5 h-3.5" />,
    color: 'text-muted-foreground',
    rail: 'bg-slate-500/70',
    surface: 'border-white/8 bg-white/[0.02]',
  },
  starting: {
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    color: 'text-sky-400',
    rail: 'bg-sky-400',
    surface: 'border-sky-400/20 bg-sky-400/8',
  },
  running: {
    icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    color: 'text-emerald-400',
    rail: 'bg-emerald-400',
    surface: 'border-emerald-400/20 bg-emerald-400/8',
  },
  completed: {
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    color: 'text-emerald-400',
    rail: 'bg-emerald-400',
    surface: 'border-white/8 bg-white/[0.02]',
  },
  blocked: {
    icon: <AlertCircle className="w-3.5 h-3.5" />,
    color: 'text-amber-400',
    rail: 'bg-amber-400',
    surface: 'border-amber-400/18 bg-amber-400/8',
  },
  failed: {
    icon: <XCircle className="w-3.5 h-3.5" />,
    color: 'text-red-400',
    rail: 'bg-red-400',
    surface: 'border-red-400/18 bg-red-400/8',
  },
  cancelled: {
    icon: <Ban className="w-3.5 h-3.5" />,
    color: 'text-muted-foreground',
    rail: 'bg-zinc-500',
    surface: 'border-white/8 bg-white/[0.02]',
  },
  timeout: {
    icon: <Clock className="w-3.5 h-3.5" />,
    color: 'text-amber-400',
    rail: 'bg-amber-400',
    surface: 'border-amber-400/18 bg-amber-400/8',
  },
};

function getStatusInfo(status: string) {
  return statusConfig[status] || statusConfig.queued;
}

// ---------------------------------------------------------------------------
// RunItem
// ---------------------------------------------------------------------------

function RunItem({
  run,
  onCancel,
  onIntervene,
  compact = true,
  locale,
  t,
}: {
  run: AgentRun;
  onCancel: (id: string) => void;
  onIntervene?: (id: string, action: 'nudge' | 'retry' | 'restart_role') => void;
  compact?: boolean;
  locale: 'en' | 'zh';
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const info = getStatusInfo(run.status);
  const isActive = isAgentRunActive(run.status);
  const duration = getAgentRunDuration(run);
  const isStaleActive = run.status === 'running' && !!run?.liveState?.staleSince;
  const canRestartRole = isStaleActive || run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled';
  const canRetry = run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled';

  return (
    <div className={cn(
      'relative overflow-hidden rounded-2xl border transition-all',
      compact ? (isActive ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border bg-background') : info.surface,
      !compact && 'shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] hover:border-white/12 hover:bg-white/[0.04]'
    )}>
      {!compact && <div className={cn('absolute inset-y-4 left-0 w-1 rounded-r-full', info.rail)} />}
      {/* Header */}
      <button
        className={cn(
          'w-full flex items-start gap-3 text-left transition-colors',
          compact ? 'hover:bg-muted/30 p-3' : 'hover:bg-white/[0.03] p-4 pl-5'
        )}
        onClick={() => setExpanded(!expanded)}
      >
        <div className={cn('mt-0.5 shrink-0', info.color)}>{info.icon}</div>
        <div className="flex-1 min-w-0">
          <div className={cn(
            'font-medium line-clamp-2 leading-snug',
            compact ? 'text-xs' : 'text-sm'
          )}>
            {run.prompt}
          </div>
          <div className={cn('flex items-center gap-2 flex-wrap', compact ? 'mt-1.5' : 'mt-2')}>
            <Badge variant="outline" className={cn(
              compact ? 'text-[9px] h-4 px-1.5' : 'h-6 rounded-full border-white/10 bg-white/[0.04] px-2.5 text-[10px] text-[color:var(--agent-text-soft)]'
            )}>
              {getAgentRunWorkspaceName(run.workspace)}
            </Badge>
            {run.roles && run.roles.length > 1 && run.currentRound !== undefined && run.maxRounds !== undefined && (
              <Badge variant="outline" className={cn(
                compact ? 'text-[9px] h-4 px-1.5 border-sky-500/30 text-sky-500/80 bg-sky-500/10' : 'h-6 rounded-full border-sky-400/20 bg-sky-400/10 px-2.5 text-[10px] text-sky-400'
              )}>
                Round {run.currentRound}/{run.maxRounds}
              </Badge>
            )}
            {run.reviewOutcome && (
              <Badge variant="outline" className={cn(
                compact ? 'text-[9px] h-4 px-1.5' : 'h-6 rounded-full px-2.5 text-[10px]',
                run.reviewOutcome === 'approved' ? 'border-emerald-500/30 text-emerald-500/80 bg-emerald-500/10' :
                run.reviewOutcome === 'rejected' ? 'border-red-500/30 text-red-500/80 bg-red-500/10' :
                'border-amber-500/30 text-amber-500/80 bg-amber-500/10'
              )}>
                {run.reviewOutcome === 'approved' ? 'Approved' :
                 run.reviewOutcome === 'rejected' ? 'Rejected' : 'Rounds Exhausted'}
              </Badge>
            )}
            <span className={cn(
              'text-muted-foreground',
              compact ? 'text-[10px]' : 'text-[11px]'
            )}>
              {getAgentRunTimeAgo(run.createdAt, locale)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isActive && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                'text-destructive hover:text-destructive',
                compact ? 'h-6 w-6' : 'h-7 w-7'
              )}
              onClick={(e) => { e.stopPropagation(); onCancel(run.runId); }}
              aria-label={t('agent.cancelRun')}
            >
              <XCircle className="w-3.5 h-3.5" />
            </Button>
          )}
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
          <div className={cn(
            'space-y-2 border-t',
            compact ? 'border-border/50 px-3 pb-3 pt-2' : 'border-white/6 px-5 pb-4 pt-3'
          )}>
          <div className="flex items-center gap-2">
            <span className={cn(
              'font-semibold uppercase',
              info.color,
              compact ? 'text-[10px]' : 'text-[11px]'
            )}>
              {t(`common.status.${run.status}`)}
            </span>
            {duration && (
              <span className={cn(
                'text-muted-foreground',
                compact ? 'text-[10px]' : 'text-[11px]'
              )}>
                • {t('agent.duration', { value: duration })}
              </span>
            )}
          </div>

          {run.lastError && (
            <div className={cn(
              'text-destructive bg-destructive/10 rounded px-2 py-1.5',
              compact ? 'text-[11px]' : 'text-xs'
            )}>
              {run.lastError}
            </div>
          )}

          {run.result && (
            <div className="space-y-1.5">
              <p className={cn(
                'text-foreground leading-relaxed line-clamp-6',
                compact ? 'text-[11px]' : 'text-sm text-[color:var(--agent-text-soft)]'
              )}>
                {run.result.summary}
              </p>
              {run.result.changedFiles.length > 0 && (
                <div className="space-y-1">
                  <span className={cn(
                    'font-semibold text-muted-foreground',
                    compact ? 'text-[10px]' : 'text-[11px]'
                  )}>
                    {t('agent.changedFiles')}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {run.result.changedFiles.map(f => (
                      <span
                        key={f}
                        className={cn(
                          'inline-flex rounded-full border px-2.5 py-1 font-mono',
                          compact
                            ? 'text-[10px] text-muted-foreground'
                            : 'border-white/8 bg-white/[0.04] text-[11px] text-[color:var(--agent-text-soft)]'
                        )}
                      >
                        {f.split('/').pop()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {run.roles && run.roles.length > 0 && (
            <div className="space-y-1.5">
              <span className={cn(
                'font-semibold text-muted-foreground',
                compact ? 'text-[10px]' : 'text-[11px]'
              )}>
                {t('agent.roleProgress', { defaultValue: 'Role Progress' })}
              </span>
              <div className="space-y-1 border-l-2 border-white/10 ml-1 pl-2">
                {run.roles.map((role, idx) => {
                  const rInfo = statusConfig[role.status] || statusConfig.queued;
                  return (
                    <div key={`${role.roleId}-${idx}`} className={cn(
                      'flex items-center justify-between py-1',
                      compact ? 'text-[10px]' : 'text-[11px]'
                    )}>
                      <div className="flex items-center gap-2">
                        <div className={rInfo.color}>{rInfo.icon}</div>
                        <span className="font-medium text-foreground">{role.roleId}</span>
                        {role.round !== undefined && <span className="text-muted-foreground opacity-60">R{role.round}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={cn('uppercase text-[9px] font-semibold tracking-wider', rInfo.color)}>
                          {role.status}
                        </span>
                        {role.reviewDecision && (
                          <span className={cn(
                            'capitalize px-1.5 py-0.5 rounded text-[9px] font-semibold',
                            role.reviewDecision === 'approved' ? 'bg-emerald-500/15 text-emerald-500' :
                            role.reviewDecision === 'rejected' ? 'bg-red-500/15 text-red-500' :
                            'bg-amber-500/15 text-amber-500'
                          )}>
                            {role.reviewDecision}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className={cn(
            'text-muted-foreground font-mono',
            compact ? 'text-[10px]' : 'text-[11px]'
          )}>
            ID: {run.runId.slice(0, 8)}
            {run.childConversationId && ` • Child: ${run.childConversationId.slice(0, 8)}`}
          </div>

          {(isStaleActive || canRestartRole || canRetry) && onIntervene && (
            <div className={cn(
              "flex flex-wrap items-center gap-2 pt-2 border-t mt-2",
              compact ? "border-border/50 text-[10px]" : "border-white/6 text-[11px]"
            )}>
              {isStaleActive && (
                <Button size="sm" variant="outline"
                  className={cn("h-6 px-2 rounded font-semibold text-sky-500 border-sky-500/20 bg-sky-500/10 hover:bg-sky-500/15 hover:text-sky-400", compact ? "text-[9px]" : "text-[10px]")}
                  onClick={(e) => { e.stopPropagation(); onIntervene(run.runId, 'nudge'); }}>
                  <Zap className="mr-1 w-3 h-3" />
                  {t('agent.nudge', { defaultValue: 'Nudge' })}
                </Button>
              )}
              {canRestartRole && (
                <Button size="sm" variant="outline"
                  className={cn("h-6 px-2 rounded font-semibold text-emerald-500 border-emerald-500/20 bg-emerald-500/10 hover:bg-emerald-500/15 hover:text-emerald-400", compact ? "text-[9px]" : "text-[10px]")}
                  onClick={(e) => { e.stopPropagation(); onIntervene(run.runId, 'restart_role'); }}>
                  <RotateCw className="mr-1 w-3 h-3" />
                  {t('agent.restartRole', { defaultValue: 'Restart Role' })}
                </Button>
              )}
              {canRetry && (
                <Button size="sm" variant="outline"
                  className={cn("h-6 px-2 rounded font-semibold text-amber-500 border-amber-500/20 bg-amber-500/10 hover:bg-amber-500/15 hover:text-amber-400", compact ? "text-[9px]" : "text-[10px]")}
                  onClick={(e) => { e.stopPropagation(); onIntervene(run.runId, 'retry'); }}>
                  <RefreshCw className="mr-1 w-3 h-3" />
                  {t('agent.retryRun', { defaultValue: 'Retry' })}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentRunsPanel
// ---------------------------------------------------------------------------

export default function AgentRunsPanel({
  currentModel,
  models,
  currentModelLabel,
  layout = 'compact',
  showRunsList = true,
  onDispatched,
}: AgentRunsPanelProps) {
  const { t, locale } = useI18n();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [prompt, setPrompt] = useState('');
  const [selectedGroup, setSelectedGroup] = useState('coding-basic');
  const [selectedSourceRunId, setSelectedSourceRunId] = useState('');
  const [approvedProductRuns, setApprovedProductRuns] = useState<AgentRun[]>([]);
  const [modelMode, setModelMode] = useState<RunModelMode>('follow-header');
  const [selectedExplicitModel, setSelectedExplicitModel] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hubProjects, setHubProjects] = useState<HubProject[]>([]);
  const [selectedHubProjectId, setSelectedHubProjectId] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.hubProjects().then(projects => {
      setHubProjects(projects || []);
      const saved = typeof window !== 'undefined' ? localStorage.getItem('antigravity_selected_project') : '';
      const next = (saved && projects.some(p => p.id === saved)) ? saved : (projects[0]?.id || '');
      if (next) setSelectedHubProjectId(next);
    }).catch(() => {});
  }, []);

  // Poll runs
  const loadRuns = useCallback(async () => {
    try {
      const data = await api.agentRuns();
      setRuns(data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (!showRunsList) return;

    const initialLoad = setTimeout(() => {
      void loadRuns();
    }, 0);
    pollRef.current = setInterval(() => {
      void loadRuns();
    }, 3000);
    return () => {
      clearTimeout(initialLoad);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadRuns, showRunsList]);
  // Fetch approved source runs when architecture-advisory or autonomous-dev-pilot is selected
  useEffect(() => {
    if (selectedGroup === 'architecture-advisory') {
      api.agentRunsByFilter({ groupId: 'product-spec', reviewOutcome: 'approved' })
        .then(runs => {
          const validRuns = runs.filter(r =>
            r.resultEnvelope && r.artifactManifestPath
          );
          setApprovedProductRuns(validRuns);
          if (validRuns.length > 0 && !selectedSourceRunId) {
            setSelectedSourceRunId(validRuns[0].runId);
          }
        })
        .catch(() => setApprovedProductRuns([]));
    } else if (selectedGroup === 'autonomous-dev-pilot') {
      api.agentRunsByFilter({ groupId: 'architecture-advisory', reviewOutcome: 'approved' })
        .then(runs => {
          const validRuns = runs.filter(r =>
            r.resultEnvelope && r.artifactManifestPath
          );
          setApprovedProductRuns(validRuns);
          if (validRuns.length > 0 && !selectedSourceRunId) {
            setSelectedSourceRunId(validRuns[0].runId);
          }
        })
        .catch(() => setApprovedProductRuns([]));
    } else {
      setApprovedProductRuns([]);
      setSelectedSourceRunId('');
    }
  }, [selectedGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDispatch = async () => {
    if (!prompt.trim()) return;
    setDispatching(true);
    setError(null);
    try {
      let modelToSend: string | undefined;
      if (modelMode === 'follow-header') {
        modelToSend = currentModel !== 'MODEL_AUTO' ? currentModel : undefined;
      } else if (modelMode === 'explicit') {
        modelToSend = selectedExplicitModel || undefined;
      }

      if (selectedGroup === 'architecture-advisory') {
        // Architecture advisory: needs source product run + inputArtifacts
        if (!selectedSourceRunId) {
          setError('Please select an approved Product Spec run as source');
          setDispatching(false);
          return;
        }
        const sourceRun = approvedProductRuns.find(r => r.runId === selectedSourceRunId);
        if (!sourceRun?.resultEnvelope?.outputArtifacts) {
          setError('Selected source run has no output artifacts');
          setDispatching(false);
          return;
        }
        const response = await api.dispatchRun({
          groupId: 'architecture-advisory',
          hubProjectId: selectedHubProjectId || undefined,
          prompt: prompt.trim(),
          model: modelToSend,
          taskEnvelope: {
            templateId: 'development-template-1',
            goal: prompt.trim(),
            inputArtifacts: sourceRun.resultEnvelope.outputArtifacts,
          },
          sourceRunIds: [selectedSourceRunId],
        });
        setPrompt('');
        if (showRunsList) await loadRuns();
        if (onDispatched) await onDispatched(response.runId);
      } else if (selectedGroup === 'autonomous-dev-pilot') {
        // Autonomous dev: needs source architecture run (runtime resolves artifacts via contract)
        if (!selectedSourceRunId) {
          setError('Please select an approved Architecture run as source');
          setDispatching(false);
          return;
        }
        const response = await api.dispatchRun({
          groupId: 'autonomous-dev-pilot',
          hubProjectId: selectedHubProjectId || undefined,
          prompt: prompt.trim(),
          model: modelToSend,
          sourceRunIds: [selectedSourceRunId],
        });
        setPrompt('');
        if (showRunsList) await loadRuns();
        if (onDispatched) await onDispatched(response.runId);
      } else {
        const response = await api.dispatchRun({
          groupId: selectedGroup,
          hubProjectId: selectedHubProjectId || undefined,
          prompt: prompt.trim(),
          model: modelToSend,
        });
        setPrompt('');
        if (showRunsList) await loadRuns();
        if (onDispatched) await onDispatched(response.runId);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('chat.errorOccurred'));
    }
    setDispatching(false);
  };

  // Cancel / Intervene
  const handleCancel = async (runId: string) => {
    try {
      await api.cancelRun(runId);
      await loadRuns();
    } catch { /* silent */ }
  };

  const handleIntervene = async (runId: string, action: 'nudge' | 'retry' | 'restart_role') => {
    try {
      await api.interveneRun(runId, { action });
      await loadRuns();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('chat.errorOccurred'));
    }
  };

  const activeRuns = runs.filter(r => r.status === 'running' || r.status === 'starting');
  const recentRuns = runs.filter(r => r.status !== 'running' && r.status !== 'starting').slice(0, 10);


  const isFullLayout = layout === 'full';
  const selectedExplicitModelLabel = models?.find(model => model.modelOrAlias?.model === selectedExplicitModel)?.label || t('composer.chooseModel');
  const modelModeLabel = modelMode === 'follow-header'
    ? (currentModelLabel || t('composer.autoSelect'))
    : modelMode === 'group-default'
      ? t('agent.groupRecommended')
      : selectedExplicitModelLabel;

  return (
    <div className={cn('space-y-3', isFullLayout && 'space-y-5')}>
      {/* Dispatch Form */}
      <div className={cn(
        'space-y-2',
        isFullLayout && 'agent-panel-strong relative rounded-[30px] p-6'
      )}>
        {isFullLayout && (
          <>
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(88,243,212,0.14),transparent_24%),radial-gradient(circle_at_bottom_right,rgba(51,194,255,0.1),transparent_22%)]" />
            <div className="relative space-y-4">
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[18px] bg-[var(--agent-highlight-soft)] text-[color:var(--agent-highlight)]">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="agent-kicker">{t('agent.dispatch')}</div>
                  <h3 className="mt-2 text-[clamp(1.8rem,4vw,2.6rem)] font-semibold leading-[0.96] tracking-[-0.04em] text-white">
                    {t('agent.dispatchTask')}
                  </h3>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Badge variant="outline" className="max-w-full rounded-full border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[color:var(--agent-text-soft)]">
                      <span className="truncate">{modelModeLabel}</span>
                    </Badge>

                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        <div className={cn('space-y-3', isFullLayout && 'relative')}>
          {isFullLayout ? (
            <div className="space-y-4">
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="space-y-2">
                  <div className="agent-kicker">{t('sidebar.selectProject')}</div>
                  <Select value={selectedHubProjectId} onValueChange={(val) => val && setSelectedHubProjectId(val)}>
                    <SelectTrigger className="h-12 rounded-2xl border-white/8 bg-white/[0.05] text-sm">
                      <span className="truncate">
                        {hubProjects.find(p => p.id === selectedHubProjectId)?.name || t('sidebar.selectProject')}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {hubProjects.map(project => (
                        <SelectItem key={project.id} value={project.id} className="text-sm">
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <div className="agent-kicker">Group</div>
                  <Select value={selectedGroup} onValueChange={(val) => val && setSelectedGroup(val)}>
                    <SelectTrigger className="h-12 rounded-2xl border-white/8 bg-white/[0.05] text-sm">
                      <span className="truncate">
                        {selectedGroup === 'coding-basic' ? 'Coding Worker'
                          : selectedGroup === 'product-spec' ? 'Product Specification'
                          : selectedGroup === 'architecture-advisory' ? 'Architecture Advisory'
                          : 'Autonomous Dev Pilot'}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="coding-basic">Coding Worker</SelectItem>
                      <SelectItem value="product-spec">Product Specification</SelectItem>
                      <SelectItem value="architecture-advisory">Architecture Advisory</SelectItem>
                      <SelectItem value="autonomous-dev-pilot">Autonomous Dev Pilot</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {(selectedGroup === 'architecture-advisory' || selectedGroup === 'autonomous-dev-pilot') && (
                <div className="space-y-2">
                  <div className="agent-kicker">
                    {selectedGroup === 'architecture-advisory' ? 'Source Product Run' : 'Source Architecture Run'}
                  </div>
                  {approvedProductRuns.length > 0 ? (
                    <Select value={selectedSourceRunId} onValueChange={(val) => val && setSelectedSourceRunId(val)}>
                      <SelectTrigger className="h-12 rounded-2xl border-white/8 bg-white/[0.05] text-sm">
                        <span className="truncate">
                          {approvedProductRuns.find(r => r.runId === selectedSourceRunId)?.prompt?.slice(0, 60) || 'Select a source run'}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {approvedProductRuns.map(r => (
                          <SelectItem key={r.runId} value={r.runId} className="text-sm">
                            <div className="flex flex-col gap-0.5">
                              <span className="truncate">{r.prompt?.slice(0, 50)}</span>
                              <span className="text-[10px] text-muted-foreground">{r.runId.slice(0, 8)} • {r.resultEnvelope?.outputArtifacts?.length || 0} artifacts</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
                      {selectedGroup === 'architecture-advisory'
                        ? 'No approved Product Spec runs available. Run a Product Spec first.'
                        : 'No approved Architecture runs available. Run Architecture Advisory first.'}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                  <div className="agent-kicker">{t('shell.currentModel')}</div>
                  <Select value={modelMode} onValueChange={(val: string | null) => { if (val) setModelMode(val as RunModelMode); }}>
                    <SelectTrigger className="h-12 rounded-2xl border-white/8 bg-white/[0.05] text-sm">
                      <span className="truncate">
                        {modelMode === 'follow-header'
                          ? t('agent.followHeader')
                          : modelMode === 'group-default'
                            ? t('agent.groupRecommended')
                            : t('agent.specificModel')}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="follow-header">{t('agent.followHeader')}</SelectItem>
                      <SelectItem value="group-default">{t('agent.groupRecommended')}</SelectItem>
                      <SelectItem value="explicit">{t('agent.specificModel')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

              {modelMode === 'explicit' && models && (
                <div className="space-y-2">
                  <div className="agent-kicker">{t('composer.chooseModel')}</div>
                  <Select value={selectedExplicitModel} onValueChange={(val: string | null) => { if (val) setSelectedExplicitModel(val); }}>
                    <SelectTrigger className="h-12 rounded-2xl border-white/8 bg-white/[0.05] text-sm">
                      <span className="truncate">{selectedExplicitModelLabel}</span>
                    </SelectTrigger>
                    <SelectContent>
                      {models.filter(m => m.modelOrAlias?.model).map(m => (
                        <SelectItem key={m.modelOrAlias!.model} value={m.modelOrAlias!.model}>
                          {m.label} {m.isRecommended ? '(Recommended)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <div className="agent-kicker">{t('agent.dispatchTask')}</div>
                <Textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder={t('agent.describeTask')}
                  className="min-h-[220px] max-h-[320px] resize-none rounded-[24px] border-white/8 bg-black/20 px-4 py-4 text-sm leading-7 text-white placeholder:text-[color:var(--agent-text-muted)]"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleDispatch(); }}
                />
              </div>

              <div className="flex flex-col gap-3 border-t border-white/6 pt-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="rounded-full border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[color:var(--agent-text-soft)]">
                    {t('agent.shortcut')}: Cmd/Ctrl + Enter
                  </Badge>
                </div>
                <Button
                  className="h-14 rounded-[18px] border-0 bg-[linear-gradient(135deg,#58f3d4,#33c2ff)] px-6 text-sm font-semibold text-slate-950 shadow-[0_20px_48px_rgba(10,154,190,0.24)] transition-all hover:-translate-y-0.5 hover:shadow-[0_24px_56px_rgba(10,154,190,0.3)] lg:min-w-[220px]"
                  onClick={handleDispatch}
                  disabled={dispatching || !prompt.trim()}
                >
                  {dispatching ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="mr-2 h-4 w-4" />
                  )}
                  {t('agent.dispatchRun')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Select value={modelMode} onValueChange={(val: string | null) => { if (val) setModelMode(val as RunModelMode); }}>
                  <SelectTrigger className="h-8 text-[11px]">
                    <SelectValue placeholder={t('shell.currentModel')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="follow-header" className="text-[11px]">{t('agent.followHeader')}</SelectItem>
                    <SelectItem value="group-default" className="text-[11px]">{t('agent.groupRecommended')}</SelectItem>
                    <SelectItem value="explicit" className="text-[11px]">{t('agent.specificModel')}</SelectItem>
                  </SelectContent>
                </Select>
                
                {modelMode === 'explicit' && models && (
                  <Select value={selectedExplicitModel} onValueChange={(val: string | null) => { if (val) setSelectedExplicitModel(val); }}>
                    <SelectTrigger className="h-8 text-[11px]">
                      <SelectValue placeholder={t('composer.chooseModel')} />
                    </SelectTrigger>
                    <SelectContent>
                      {models.filter(m => m.modelOrAlias?.model).map(m => (
                        <SelectItem key={m.modelOrAlias!.model} value={m.modelOrAlias!.model} className="text-[11px]">
                          {m.label} {m.isRecommended ? '(Rec.)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <Select value={selectedGroup} onValueChange={(val) => val && setSelectedGroup(val)}>
                <SelectTrigger className="h-8 text-[11px]">
                  <span className="truncate">
                    {selectedGroup === 'coding-basic' ? 'Coding Worker'
                      : selectedGroup === 'product-spec' ? 'Product Spec'
                      : selectedGroup === 'architecture-advisory' ? 'Architecture'
                      : 'Dev Pilot'}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="coding-basic" className="text-[11px]">Coding Worker</SelectItem>
                  <SelectItem value="product-spec" className="text-[11px]">Product Spec</SelectItem>
                  <SelectItem value="architecture-advisory" className="text-[11px]">Architecture</SelectItem>
                  <SelectItem value="autonomous-dev-pilot" className="text-[11px]">Dev Pilot</SelectItem>
                </SelectContent>
              </Select>

              {(selectedGroup === 'architecture-advisory' || selectedGroup === 'autonomous-dev-pilot') && (
                <>
                  {approvedProductRuns.length > 0 ? (
                    <Select value={selectedSourceRunId} onValueChange={(val) => val && setSelectedSourceRunId(val)}>
                      <SelectTrigger className="h-8 text-[11px]">
                        <span className="truncate">
                          {approvedProductRuns.find(r => r.runId === selectedSourceRunId)?.prompt?.slice(0, 40) || 'Select source'}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {approvedProductRuns.map(r => (
                          <SelectItem key={r.runId} value={r.runId} className="text-[11px]">
                            <span className="truncate">{r.prompt?.slice(0, 40)} ({r.runId.slice(0, 8)})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-400">
                      {selectedGroup === 'architecture-advisory' ? 'No approved Product runs' : 'No approved Architecture runs'}
                    </div>
                  )}
                </>
              )}

              <div className="flex gap-1.5">
                <Textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder={t('agent.describeTaskShort')}
                  className="min-h-[60px] max-h-[100px] resize-none text-xs"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleDispatch(); }}
                />
              </div>

              <Button
                className="h-8 w-full text-xs"
                onClick={handleDispatch}
                disabled={dispatching || !prompt.trim()}
              >
                {dispatching ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('agent.dispatchRun')}
              </Button>
            </>
          )}
        </div>

        {error && (
          <div className={cn(
            'text-destructive bg-destructive/10 rounded px-2 py-1.5',
            isFullLayout ? 'rounded-2xl border border-red-400/20 px-4 py-3 text-sm' : 'text-[11px]'
          )}>
            {error}
          </div>
        )}
      </div>

      {showRunsList && (
        <div className={cn(
          'space-y-1.5',
          isFullLayout && 'agent-panel rounded-[30px] p-5'
        )}>
          {isFullLayout && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <div>
                <div className="agent-kicker">{t('shell.agents')}</div>
                <h4 className="text-xl font-semibold tracking-tight text-white">{t('sidebar.recentRuns')}</h4>
              </div>
              <div className="ml-auto flex gap-2">
                <Badge variant="outline" className="rounded-full border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-emerald-300">
                  {activeRuns.length} {t('sidebar.active')}
                </Badge>
                <Badge variant="outline" className="rounded-full border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] uppercase tracking-[0.2em] text-[color:var(--agent-text-soft)]">
                  {recentRuns.length} {t('sidebar.recent')}
                </Badge>
              </div>
            </div>
          )}

          {activeRuns.length > 0 && (
            <div className="mb-1 flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-emerald-500" />
              <span className={cn(
                'font-semibold text-emerald-500 uppercase tracking-wider',
                isFullLayout ? 'text-[11px]' : 'text-[10px]'
              )}>
                {t('sidebar.active')} ({activeRuns.length})
              </span>
            </div>
          )}

          {activeRuns.map(run => (
            <RunItem key={run.runId} run={run} onCancel={handleCancel} onIntervene={handleIntervene} compact={!isFullLayout} locale={locale} t={t} />
          ))}

          {recentRuns.length > 0 && (
            <>
              <div className="mt-2 mb-1 flex items-center justify-between">
                <span className={cn(
                  'font-semibold text-muted-foreground uppercase tracking-wider',
                  isFullLayout ? 'text-[11px]' : 'text-[10px]'
                )}>
                  {t('sidebar.recent')}
                </span>
                <Button variant="ghost" size="icon" className={cn(isFullLayout ? 'h-8 w-8 rounded-xl hover:bg-white/[0.05]' : 'h-5 w-5')} onClick={loadRuns}>
                  <RefreshCw className="w-3 h-3 text-muted-foreground" />
                </Button>
              </div>
              {recentRuns.map(run => (
                <RunItem key={run.runId} run={run} onCancel={handleCancel} onIntervene={handleIntervene} compact={!isFullLayout} locale={locale} t={t} />
              ))}
            </>
          )}

          {runs.length === 0 && (
            <div className={cn(
              'text-center text-muted-foreground',
              isFullLayout ? 'rounded-[24px] border border-dashed border-white/10 bg-white/[0.02] py-14 text-sm' : 'py-6 text-[11px]'
            )}>
              {isFullLayout ? (
                <div className="space-y-3">
                  <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[20px] border border-white/8 bg-white/[0.03] text-[color:var(--agent-text-soft)]">
                    <Bot className="h-5 w-5" />
                  </div>
                  <div className="font-medium text-white">{t('agent.noRuns')}</div>
                </div>
              ) : (
                t('agent.noRuns')
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
