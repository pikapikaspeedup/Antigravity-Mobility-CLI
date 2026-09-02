'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from '@/components/sidebar';
import Chat from '@/components/chat';
import ChatInput from '@/components/chat-input';
import KnowledgeWorkspace from '@/components/knowledge-panel';
import LogViewerPanel from '@/components/log-viewer-panel';
import AgentRunsPanel from '@/components/agent-runs-panel';
import AgentRunDetail from '@/components/agent-run-detail';
import ProjectsPanel from '@/components/projects-panel';
import LocaleToggle from '@/components/locale-toggle';
import { useI18n } from '@/components/locale-provider';
import { api, connectWs } from '@/lib/api';
import type { AgentRun, Project, ModelConfig, Skill, StepsData, Workflow, TemplateSummaryFE, ResumeAction } from '@/lib/types';
import ActiveTasksPanel, { ActiveTask } from '@/components/active-tasks-panel';
import { Download, Menu, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

import { isAgentRunActive, pickDefaultAgentRun } from '@/lib/agent-run-utils';
import { getModelLabel } from '@/lib/model-labels';
import { AppShell, StatusChip, WorkspaceHeader } from '@/components/ui/app-shell';

type SidebarSection = 'conversations' | 'projects' | 'agents' | 'knowledge';

export default function Home() {
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>('conversations');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState('Antigravity');
  const [steps, setSteps] = useState<StepsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [currentModel, setCurrentModel] = useState('MODEL_PLACEHOLDER_M26');
  const [skills] = useState<Skill[]>([]);
  const [workflows] = useState<Workflow[]>([]);
  const [connected, setConnected] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [, setCascadeStatus] = useState('idle');
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [agenticMode, setAgenticMode] = useState(true);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  const [dismissedTasks, setDismissedTasks] = useState<Set<string>>(new Set());
  const [sendError, setSendError] = useState<string | null>(null);
  const [activeRunsCount, setActiveRunsCount] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [selectedAgentRunId, setSelectedAgentRunId] = useState<string | null>(null);
  const [agentRunsLoading, setAgentRunsLoading] = useState(true);

  const [selectedKnowledgeId, setSelectedKnowledgeId] = useState<string | null>(null);
  const [selectedKnowledgeTitle, setSelectedKnowledgeTitle] = useState('');
  const [knowledgeRefreshSignal, setKnowledgeRefreshSignal] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const lastStepCountRef = useRef(0);
  const apiLoadedRef = useRef(false);
  const agentStateLoadedRef = useRef(false);
  const [templates, setTemplates] = useState<TemplateSummaryFE[]>([]);

  useEffect(() => {
    api.models().then(data => {
      if (data.clientModelConfigs?.length) {
        const sortedModels = [...data.clientModelConfigs].sort((a, b) => {
          if (a.isRecommended !== b.isRecommended) return a.isRecommended ? -1 : 1;
          return a.label.localeCompare(b.label);
        });
        setModels(sortedModels);

        const saved = localStorage.getItem('antigravity_selected_model');
        const defaultModel = saved || 'MODEL_AUTO';
        const exists = defaultModel === 'MODEL_AUTO' || sortedModels.some(model => model.modelOrAlias?.model === defaultModel);
        setCurrentModel(exists ? defaultModel : 'MODEL_AUTO');
      }
    }).catch(() => { });

    // Load pipeline templates once on mount
    api.pipelines().then(setTemplates).catch(() => {});
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('antigravity_selected_model', currentModel);
    }
  }, [currentModel]);

  useEffect(() => {
    wsRef.current = connectWs(
      (cascadeId, data, active, status, extra) => {
        setActiveTasks(prev => {
          const existing = prev.find(task => task.cascadeId === cascadeId);
          const nextTask: ActiveTask = {
            cascadeId,
            title: existing?.title || cascadeId.slice(0, 8),
            workspace: existing?.workspace || '',
            stepCount: data.steps?.length || existing?.stepCount || 0,
            totalSteps: extra?.totalLength || existing?.totalSteps,
            lastTaskBoundary: extra?.lastTaskBoundary || existing?.lastTaskBoundary,
            isActive: active,
            cascadeStatus: status,
          };

          if (existing) {
            return prev.map(task => task.cascadeId === cascadeId ? nextTask : task);
          }

          return [...prev, nextTask];
        });

        setActiveId(currentId => {
          if (currentId === cascadeId) {
            const newLength = data.steps?.length || 0;
            const threshold = lastStepCountRef.current;
            if (newLength > 0 && (apiLoadedRef.current ? newLength > threshold : newLength >= threshold)) {
              lastStepCountRef.current = newLength;
              setSteps(data);
            }
            setIsActive(active);
            setCascadeStatus(status);
          }

          return currentId;
        });
      },
      setConnected,
    );

    return () => {
      wsRef.current?.close();
    };
  }, []);

  const loadAgentState = useCallback(async (preferredRunId?: string | null) => {
    if (!agentStateLoadedRef.current) {
      setAgentRunsLoading(true);
    }

    try {
      const [fetchedProjects, runs] = await Promise.all([
        api.projects().catch(() => [] as Project[]),
        api.agentRuns(),
      ]);

      setProjects(fetchedProjects);
      setAgentRuns(runs);
      setSelectedAgentRunId(prev => preferredRunId
        ? (runs.some(run => run.runId === preferredRunId) ? preferredRunId : pickDefaultAgentRun(runs, prev))
        : pickDefaultAgentRun(runs, prev));
      setActiveRunsCount(runs.filter(run => isAgentRunActive(run.status)).length);
    } catch {
      setActiveRunsCount(0);
      setAgentRuns([]);
      setSelectedAgentRunId(null);
    } finally {
      agentStateLoadedRef.current = true;
      setAgentRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgentState();
    const timer = setInterval(() => {
      void loadAgentState(selectedAgentRunId);
    }, 5000);
    return () => clearInterval(timer);
  }, [loadAgentState, selectedAgentRunId]);

  const loadSteps = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await api.conversationSteps(id);
      const apiLength = data.steps?.length || 0;
      if (apiLength >= lastStepCountRef.current) {
        lastStepCountRef.current = apiLength;
        apiLoadedRef.current = true;
        setSteps(data);
      } else {
        apiLoadedRef.current = true;
      }
    } catch {
      setSteps(prev => prev ? prev : null);
    }
    setLoading(false);
  }, []);

  const handleSelect = (id: string, title: string) => {
    setSidebarSection('conversations');
    lastStepCountRef.current = 0;
    apiLoadedRef.current = false;
    setActiveId(id);
    setActiveTitle(title || id.slice(0, 8));
    setSteps(null);
    setSendError(null);
    void loadSteps(id);

    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', cascadeId: id }));
    }

    setActiveTasks(prev => prev.map(task => task.cascadeId === id ? { ...task, title: title || id.slice(0, 8) } : task));
  };

  const handleLoadAgentConversation = (id: string, title: string) => {
    lastStepCountRef.current = 0;
    apiLoadedRef.current = false;
    setActiveId(id);
    setActiveTitle(title || id.slice(0, 8));
    setSteps(null);
    setSendError(null);
    void loadSteps(id);

    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', cascadeId: id }));
    }

    setActiveTasks(prev => prev.map(task => task.cascadeId === id ? { ...task, title: title || id.slice(0, 8) } : task));
  };

  const handleNew = async (projectId: string) => {
    try {
      const response = await api.createConversation(projectId);
      if (response.error) {
        alert(response.error);
        return;
      }
      if (response.cascadeId) {
        handleSelect(response.cascadeId, 'New conversation');
      }
    } catch (error: unknown) {
      alert('Failed: ' + (error instanceof Error ? error.message : 'unknown'));
    }
  };

  const handleSend = async (text: string, attachments?: unknown) => {
    if (!activeId) return;
    setSendError(null);

    let targetModel = currentModel;
    if (targetModel === 'MODEL_AUTO') {
      const priority = ['MODEL_PLACEHOLDER_M26', 'MODEL_PLACEHOLDER_M37', 'MODEL_PLACEHOLDER_M36', 'MODEL_PLACEHOLDER_M35', 'MODEL_PLACEHOLDER_M47'];
      let found = false;
      for (const candidate of priority) {
        const config = models.find(model => model.modelOrAlias?.model === candidate);
        if (config && config.quotaInfo?.remainingFraction !== undefined && config.quotaInfo.remainingFraction > 0) {
          targetModel = candidate;
          found = true;
          break;
        }
      }

      if (!found) {
        targetModel = models.find(model => model.modelOrAlias?.model === 'MODEL_PLACEHOLDER_M47')?.modelOrAlias?.model
          || models[0]?.modelOrAlias?.model
          || 'MODEL_PLACEHOLDER_M26';
      }
    }

    try {
      await api.sendMessage(activeId, text, targetModel, agenticMode, attachments);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setSendError(`发送失败: ${message}`);
      setTimeout(() => setSendError(null), 6000);
    }
  };

  const handleProceed = async (uri: string) => {
    if (!activeId || !uri) return;
    try {
      await api.proceed(activeId, uri, currentModel);
    } catch {
      /* silent */
    }
  };

  const handleCancel = async () => {
    if (!activeId) return;
    try {
      await api.cancel(activeId);
      setTimeout(() => {
        void loadSteps(activeId);
      }, 500);
    } catch {
      /* silent */
    }
  };

  const handleCancelAgentRun = useCallback(async (runId: string) => {
    try {
      await api.cancelRun(runId);
      await loadAgentState(runId);
    } catch {
      /* silent */
    }
  }, [loadAgentState]);

  const handleInterveneAgentRun = useCallback(async (runId: string, action: 'nudge' | 'retry' | 'restart_role' | 'cancel' | 'evaluate') => {
    try {
      await api.interveneRun(runId, { action });
      await loadAgentState(runId);
    } catch (err: unknown) {
      throw err;
    }
  }, [loadAgentState]);

  const handleResumeProject = useCallback(async (
    projectId: string,
    stageIndex: number,
    action: ResumeAction,
  ) => {
    await api.resumeProject(projectId, { stageIndex, action });
    await loadAgentState();
  }, [loadAgentState]);

  const handleRevert = async (stepIndex: number) => {
    if (!activeId) return;

    let targetIndex = stepIndex;
    if (steps?.steps?.[stepIndex]?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      targetIndex = Math.max(0, stepIndex - 1);
      while (targetIndex > 0) {
        const type = steps.steps[targetIndex]?.type || '';
        if (type !== 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE' && type !== 'CORTEX_STEP_TYPE_CHECKPOINT') break;
        targetIndex--;
      }
    }

    if (steps?.steps) {
      const truncated = steps.steps.slice(0, targetIndex + 1);
      lastStepCountRef.current = truncated.length;
      setSteps({ ...steps, steps: truncated });
    }

    try {
      await api.revert(activeId, targetIndex, currentModel);
      lastStepCountRef.current = 0;
      apiLoadedRef.current = false;
      setTimeout(() => {
        void loadSteps(activeId);
      }, 800);
    } catch {
      /* silent */
    }
  };

  const handleExportMarkdown = useCallback(() => {
    if (!steps?.steps?.length) return;

    let markdown = `# Conversation: ${activeTitle}\n\n`;
    steps.steps.forEach(step => {
      const type = step.type || '';
      if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
        const text = (step.userInput?.items || []).filter(item => item.text).map(item => item.text).join('').trim();
        if (text) markdown += `**User**:\n\n${text}\n\n---\n\n`;
      } else if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
        const text = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || '';
        if (text) markdown += `**Assistant**:\n\n${text}\n\n---\n\n`;
      } else if (type === 'CORTEX_STEP_TYPE_TASK_BOUNDARY') {
        const boundary = step.taskBoundary || {};
        markdown += `> **Task Boundary: ${boundary.taskName || 'Task'}**\n`;
        if (boundary.taskStatus) markdown += `> Status: ${boundary.taskStatus}\n`;
        if (boundary.taskSummary) markdown += `> ${boundary.taskSummary}\n\n`;
      } else if (type === 'CORTEX_STEP_TYPE_NOTIFY_USER') {
        const text = step.notifyUser?.notificationContent || '';
        if (text) markdown += `**Assistant Notification**:\n\n${text}\n\n---\n\n`;
      }
    });

    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeTitle.replace(/[^a-zA-Z0-9-_\u4e00-\u9fa5]/g, '_')}_export.md`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [steps, activeTitle]);

  const handleKnowledgeSelect = useCallback((id: string, title: string) => {
    setSidebarSection('knowledge');
    setSelectedKnowledgeId(id);
    setSelectedKnowledgeTitle(title);
  }, []);

  const handleKnowledgeTitleChange = useCallback((title: string | null) => {
    setSelectedKnowledgeTitle(title || '');
  }, []);

  const handleKnowledgeDeleted = useCallback(() => {
    setSelectedKnowledgeId(null);
    setSelectedKnowledgeTitle('');
    setKnowledgeRefreshSignal(value => value + 1);
  }, []);

  const isRunning = isActive;
  const currentModelLabel = getModelLabel(currentModel, models, { autoLabel: t('composer.autoSelect') });
  const selectedAgentRun = agentRuns.find(run => run.runId === selectedAgentRunId) || null;
  const displayTitle = sidebarSection === 'agents'
    ? t('shell.agents')
    : sidebarSection === 'knowledge'
      ? t('shell.knowledge')
      : activeTitle;

  return (
    <>
      <AppShell
        sidebar={(
          <Sidebar
            activeId={activeId}
            onSelect={handleSelect}
            onNew={(projectId) => { void handleNew(projectId); }}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            currentModelLabel={currentModelLabel}
            onSectionChange={(section) => setSidebarSection(section)}
            activeRunsCount={activeRunsCount}
            agentRuns={agentRuns}
            selectedAgentRunId={selectedAgentRunId}
            onSelectAgentRun={(runId) => {
              setSidebarSection('agents');
              setSelectedAgentRunId(runId);
            }}
            selectedKnowledgeId={selectedKnowledgeId}
            onSelectKnowledge={handleKnowledgeSelect}
            knowledgeRefreshSignal={knowledgeRefreshSignal}
            section={sidebarSection}
            projects={projects}
            selectedProjectId={selectedProjectId}
            onSelectProject={(id: string) => {
              setSidebarSection('projects');
              setSelectedProjectId(id);
            }}
          />
        )}
        header={(
          <header className="relative z-10 flex h-14 shrink-0 items-center gap-3 border-b border-[var(--app-border-soft)] bg-[rgba(9,17,27,0.86)] px-3 backdrop-blur-xl supports-[backdrop-filter]:bg-[rgba(9,17,27,0.78)] md:px-5">
            <Button variant="ghost" size="icon" className="shrink-0 md:hidden" onClick={() => setSidebarOpen(true)}>
              <Menu className="h-4 w-4" />
            </Button>

            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-[14px] border border-[var(--app-border-soft)] bg-[var(--app-raised)] text-sm font-semibold text-[var(--app-text)] shadow-[0_12px_30px_rgba(0,0,0,0.2)]">
                A
              </div>
              <div className="min-w-0">
                <div className="app-eyebrow">{t('common.appName')}</div>
                <div className="truncate text-sm font-semibold text-[var(--app-text)]">{displayTitle}</div>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <LocaleToggle className="hidden md:inline-flex" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLogViewerOpen(true)}
                className="rounded-full border-[var(--app-border-soft)] bg-[var(--app-raised)] text-[var(--app-text-soft)] hover:border-[var(--app-border-strong)] hover:bg-[var(--app-raised-2)] hover:text-[var(--app-text)]"
                aria-label={t('shell.logs')}
                title={t('shell.logs')}
              >
                <Terminal className="h-4 w-4" />
                <span className="hidden md:inline">{t('shell.logs')}</span>
              </Button>
              {sidebarSection === 'conversations' && steps?.steps?.length ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExportMarkdown}
                  className="rounded-full border-[var(--app-border-soft)] bg-[var(--app-raised)] text-[var(--app-text-soft)] hover:border-[var(--app-border-strong)] hover:bg-[var(--app-raised-2)] hover:text-[var(--app-text)]"
                  aria-label={t('shell.export')}
                  title={t('shell.export')}
                >
                  <Download className="h-4 w-4" />
                  <span className="hidden md:inline">{t('shell.export')}</span>
                </Button>
              ) : null}
            </div>
          </header>
        )}
      >
        {sidebarSection === 'projects' ? (
          <div className="agent-stage relative flex-1 overflow-hidden">
            <div className="pointer-events-none absolute inset-0 agent-grid opacity-30" />
            <ScrollArea className="h-full">
              <div className="relative mx-auto flex w-full max-w-[1580px] flex-col gap-5 px-4 py-4 md:px-8 md:py-6">
                <ProjectsPanel
                  projects={projects}
                  agentRuns={agentRuns}
                  selectedProjectId={selectedProjectId}
                  onSelectProject={setSelectedProjectId}
                  onSelectRun={(runId) => {
                    setSelectedAgentRunId(runId);
                    // Note: NOT switching to agents section — this is only for legacy projects
                    // Pipeline projects show run detail inline in the workbench
                  }}
                  templates={templates}
                  models={models}
                  onResume={handleResumeProject}
                  onCancelRun={handleCancelAgentRun}
                  onOpenConversation={(id, title) => handleSelect(id, title || t('shell.agents'))}
                  onRefresh={() => loadAgentState(selectedAgentRunId)}
                />
              </div>
            </ScrollArea>
          </div>
        ) : sidebarSection === 'agents' ? (
          <div className="agent-stage relative flex-1 overflow-hidden">
            <div className="pointer-events-none absolute inset-0 agent-grid opacity-30" />
            <ScrollArea className="h-full">
              <div className="relative mx-auto flex w-full max-w-[1580px] flex-col gap-5 px-4 py-4 md:px-8 md:py-6">

                <div className="grid gap-5 xl:grid-cols-[500px_minmax(0,1fr)] 2xl:grid-cols-[540px_minmax(0,1fr)]">
                  <div className="space-y-5">
                    <AgentRunsPanel
                      currentModel={currentModel}
                      currentModelLabel={currentModelLabel}
                      models={models}
                      layout="full"
                      showRunsList={false}
                      onDispatched={async (runId) => {
                        setSelectedAgentRunId(runId);
                        await loadAgentState(runId);
                      }}
                    />
                  </div>

                  <AgentRunDetail
                    loading={agentRunsLoading}
                    run={selectedAgentRun}
                    models={models}
                    onCancel={handleCancelAgentRun}
                    onIntervene={handleInterveneAgentRun}
                    onOpenConversation={(id, title) => handleSelect(id, title || t('shell.agents'))}
                    onOpenChatTab={(id, title) => handleLoadAgentConversation(id, title || t('shell.agents'))}
                    renderChat={activeId ? () => (
                      <div className="flex flex-col h-full bg-transparent">
                        <div className="flex-1 overflow-hidden relative">
                          <Chat
                            steps={steps}
                            loading={loading}
                            currentModel={currentModel}
                            onProceed={handleProceed}
                            onRevert={handleRevert}
                            isActive={isActive}
                          />
                        </div>
                        <div className="shrink-0 border-t border-white/6 px-4 pb-4 pt-3">
                          {sendError ? (
                            <div className="mb-3 flex justify-center">
                              <div className="rounded-full border border-red-400/18 bg-red-400/10 px-4 py-2 text-sm font-medium text-red-100">
                                {sendError}
                              </div>
                            </div>
                          ) : null}
                          <ChatInput
                            activeId={activeId}
                            onSend={handleSend}
                            onCancel={handleCancel}
                            disabled={loading}
                            isRunning={isRunning}
                            connected={connected}
                            models={models}
                            currentModel={currentModel}
                            onModelChange={setCurrentModel}
                            skills={skills}
                            workflows={workflows}
                            agenticMode={agenticMode}
                            onAgenticModeChange={setAgenticMode}
                          />
                        </div>
                      </div>
                    ) : undefined}
                  />
                </div>
              </div>
            </ScrollArea>
          </div>
        ) : sidebarSection === 'knowledge' ? (
          <div className="app-shell-stage relative flex-1 overflow-hidden">
            <div className="pointer-events-none absolute inset-0 agent-grid opacity-20" />
            <ScrollArea className="h-full">
              <div className="relative mx-auto flex w-full max-w-[1480px] flex-col gap-5 px-4 py-4 md:px-8 md:py-6">

                <KnowledgeWorkspace
                  selectedId={selectedKnowledgeId}
                  onTitleChange={handleKnowledgeTitleChange}
                  onDeleted={handleKnowledgeDeleted}
                />
              </div>
            </ScrollArea>
          </div>
        ) : (
          <div className="app-shell-stage relative flex-1 overflow-hidden">
            <div className="pointer-events-none absolute inset-0 agent-grid opacity-25" />
            <div className="relative flex h-full flex-col px-3 pb-3 pt-3 md:px-5 md:pb-5 md:pt-5">
              <div className="chat-stage-panel relative mx-auto flex h-full w-full max-w-[1240px] min-w-0 flex-col overflow-hidden rounded-[32px]">
                <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-white/24 to-transparent" />

                <div className="chat-stage-content relative min-h-0 flex-1">
                  <Chat
                    steps={steps}
                    loading={loading}
                    currentModel={currentModel}
                    onProceed={handleProceed}
                    onRevert={handleRevert}
                    isActive={isActive}
                  />
                </div>

                {activeId ? (
                  <div className="shrink-0 border-t border-white/6 bg-[linear-gradient(180deg,rgba(9,17,27,0)_0%,rgba(9,17,27,0.45)_18%,rgba(9,17,27,0.82)_100%)] px-3 pb-3 pt-3 md:px-5 md:pb-5 md:pt-4">
                    {sendError ? (
                      <div className="mb-3 flex justify-center">
                        <div className="rounded-full border border-red-400/18 bg-red-400/10 px-4 py-2 text-sm font-medium text-red-100 shadow-[0_18px_40px_rgba(0,0,0,0.24)]">
                          {sendError}
                        </div>
                      </div>
                    ) : null}

                    <ChatInput
                      activeId={activeId}
                      onSend={handleSend}
                      onCancel={handleCancel}
                      disabled={loading}
                      isRunning={isRunning}
                      connected={connected}
                      models={models}
                      currentModel={currentModel}
                      onModelChange={setCurrentModel}
                      skills={skills}
                      workflows={workflows}
                      agenticMode={agenticMode}
                      onAgenticModeChange={setAgenticMode}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </AppShell>

      <LogViewerPanel open={logViewerOpen} onClose={() => setLogViewerOpen(false)} />
      <ActiveTasksPanel
        tasks={activeTasks
          .filter(task => !dismissedTasks.has(task.cascadeId))
          .map(task => {
            const run = agentRuns.find(r => r.childConversationId === task.cascadeId);
            return run?.supervisorReviews ? { ...task, supervisorReviews: run.supervisorReviews } : task;
          })}
        onSelect={(id, title) => handleSelect(id, title)}
        onDismiss={(id) => setDismissedTasks(prev => new Set(prev).add(id))}
        activeCascadeId={activeId}
      />
    </>
  );
}
