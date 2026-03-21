'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from '@/components/sidebar';
import Chat from '@/components/chat';
import ChatInput from '@/components/chat-input';
import KnowledgePanel from '@/components/knowledge-panel';
import LogViewerPanel from '@/components/log-viewer-panel';
import { api, connectWs } from '@/lib/api';
import type { StepsData, ModelConfig, Skill, Workflow } from '@/lib/types';
import ActiveTasksPanel, { ActiveTask } from '@/components/active-tasks-panel';
import { Menu, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTitle, setActiveTitle] = useState('Antigravity');
  const [steps, setSteps] = useState<StepsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [currentModel, setCurrentModel] = useState('MODEL_PLACEHOLDER_M26');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [connected, setConnected] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [cascadeStatus, setCascadeStatus] = useState('idle');
  const [knowledgePanelOpen, setKnowledgePanelOpen] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [agenticMode, setAgenticMode] = useState(true);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  const [dismissedTasks, setDismissedTasks] = useState<Set<string>>(new Set());
  const [sendError, setSendError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastStepCountRef = useRef(0);

  useEffect(() => {
    api.models().then(d => {
      if (d.clientModelConfigs?.length) {
        // Enforce stable sorting by label length then alphabetically, keeping Recommended first
        const sortedModels = [...d.clientModelConfigs].sort((a, b) => {
          if (a.isRecommended !== b.isRecommended) return a.isRecommended ? -1 : 1;
          return a.label.localeCompare(b.label);
        });
        setModels(sortedModels);
        
        // Restore saved preference or use Auto
        const saved = localStorage.getItem('antigravity_selected_model');
        const defaultModel = saved || 'MODEL_AUTO';
        
        // Only set if the saved model actually exists in the fetched list (or is Auto)
        const exists = defaultModel === 'MODEL_AUTO' || sortedModels.some(m => m.modelOrAlias?.model === defaultModel);
        if (exists) {
          setCurrentModel(defaultModel);
        } else {
          setCurrentModel('MODEL_AUTO'); // Fallback to Auto
        }
      }
    }).catch(() => {});
  }, []);

  // Add a separate effect just to persist changes to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('antigravity_selected_model', currentModel);
    }
  }, [currentModel]);

  useEffect(() => {
    wsRef.current = connectWs(
      (cascadeId, data, active, status, extra) => {
        // Update active tasks panel for ALL conversations
        setActiveTasks(prev => {
          const existing = prev.find(t => t.cascadeId === cascadeId);
          const newTask: ActiveTask = {
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
            return prev.map(t => t.cascadeId === cascadeId ? newTask : t);
          }
          return [...prev, newTask];
        });

        // Update main chat view only for the current active conversation
        setActiveId(cur => {
          if (cur === cascadeId) {
            const newLen = data.steps?.length || 0;
            if (newLen > 0 && newLen >= lastStepCountRef.current) {
              lastStepCountRef.current = newLen;
              setSteps(data);
            } else if (newLen > 0) {
              console.warn(`[WS] Guard filtered: newLen=${newLen} < lastStepCount=${lastStepCountRef.current} for ${cascadeId.slice(0,8)}`);
            }
            setIsActive(active);
            setCascadeStatus(status);
          } else {
            console.log(`[WS] Ignored update for ${cascadeId.slice(0,8)} (active=${cur?.slice(0,8)})`);
          }
          return cur;
        });
      },
      setConnected,
    );
    return () => { wsRef.current?.close(); };
  }, []);

  const loadSteps = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const data = await api.conversationSteps(id);
      lastStepCountRef.current = data.steps?.length || 0;
      setSteps(data);
    } catch { setSteps(null); }
    setLoading(false);
  }, []);

  const handleSelect = (id: string, title: string) => {
    console.log(`[Select] ${id.slice(0,8)} "${title}" | wsReady=${wsRef.current?.readyState} lastSteps=${lastStepCountRef.current}`);
    setActiveId(id);
    setActiveTitle(title || id.slice(0, 8));
    setSteps(null);
    setSendError(null);
    loadSteps(id);
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', cascadeId: id }));
    } else {
      console.warn(`[Select] WS not ready (state=${wsRef.current?.readyState}), subscribe skipped for ${id.slice(0,8)}`);
    }
    // Update the task title in activeTasks
    setActiveTasks(prev => prev.map(t => t.cascadeId === id ? { ...t, title: title || id.slice(0, 8) } : t));
  };

  const handleNew = async (workspace: string) => {
    console.log(`[NewConv] Creating in workspace: ${workspace}`);
    try {
      const d = await api.createConversation(workspace);
      if (d.error) { alert(d.error); return; }
      if (d.cascadeId) {
        console.log(`[NewConv] Created ${d.cascadeId.slice(0,8)}, selecting...`);
        handleSelect(d.cascadeId, 'New conversation');
      }
    } catch (e: unknown) { alert('Failed: ' + (e instanceof Error ? e.message : 'unknown')); }
  };

  const handleSend = async (text: string, attachments?: any) => {
    if (!activeId) return;
    setSendError(null);
    
    // Resolve Auto model if selected
    let targetModel = currentModel;
    if (targetModel === 'MODEL_AUTO') {
      // Fallback priority: M26(Opus) -> M37(Pro High) -> M36(Pro Low) -> M35(Sonnet) -> M47(Flash)
      const priority = ['MODEL_PLACEHOLDER_M26', 'MODEL_PLACEHOLDER_M37', 'MODEL_PLACEHOLDER_M36', 'MODEL_PLACEHOLDER_M35', 'MODEL_PLACEHOLDER_M47'];
      let found = false;
      for (const p of priority) {
        const conf = models.find(m => m.modelOrAlias?.model === p);
        if (conf && conf.quotaInfo && conf.quotaInfo.remainingFraction !== undefined && conf.quotaInfo.remainingFraction > 0) {
          targetModel = p;
          found = true;
          console.log(`[Auto Resolve] Resolved ${p} (quota=${conf.quotaInfo.remainingFraction})`);
          break;
        }
      }
      if (!found) {
        // If all quotas exhausted or info missing, fallback to Flash or whatever is first
        targetModel = models.find(m => m.modelOrAlias?.model === 'MODEL_PLACEHOLDER_M47')?.modelOrAlias?.model 
                      || models[0]?.modelOrAlias?.model || 'MODEL_PLACEHOLDER_M26';
        console.log(`[Auto Resolve] Fallback to ${targetModel} (no quota found)`);
      }
    }

    try {
      await api.sendMessage(activeId, text, targetModel, agenticMode, attachments);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      console.error(`[Send] Failed for ${activeId.slice(0,8)}: ${msg}`);
      setSendError(`发送失败: ${msg}`);
      setTimeout(() => setSendError(null), 6000);
    }
  };

  const handleProceed = async (uri: string) => {
    if (!activeId || !uri) return;
    try { await api.proceed(activeId, uri, currentModel); } catch { /* */ }
  };

  const handleCancel = async () => {
    if (!activeId) return;
    try {
      await api.cancel(activeId);
      // Force refresh steps to escape stuck isRunning state
      setTimeout(() => loadSteps(activeId), 500);
    } catch { /* */ }
  };

  const handleRevert = async (stepIndex: number) => {
    if (!activeId) return;

    // Find the actual revert target:
    // If the step at stepIndex is USER_INPUT, revert to the step before it
    // so the user's own message is also removed.
    let targetIndex = stepIndex;
    if (steps?.steps?.[stepIndex]?.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      // Walk backward to find the last non-ephemeral step before this USER_INPUT
      targetIndex = Math.max(0, stepIndex - 1);
      while (targetIndex > 0) {
        const t = steps.steps[targetIndex]?.type || '';
        if (t !== 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE' && t !== 'CORTEX_STEP_TYPE_CHECKPOINT') break;
        targetIndex--;
      }
    }

    // Immediately truncate local steps for instant UI feedback
    if (steps?.steps) {
      const truncated = steps.steps.slice(0, targetIndex + 1);
      lastStepCountRef.current = truncated.length;
      setSteps({ ...steps, steps: truncated });
    }

    try {
      await api.revert(activeId, targetIndex, currentModel);
      // Reset monotonic guard — revert produces a shorter steps array
      lastStepCountRef.current = 0;
      // Fallback refresh in case WS push is delayed
      setTimeout(() => loadSteps(activeId), 800);
    } catch { /* */ }
  };

  const handleExportMarkdown = useCallback(() => {
    if (!steps || !steps.steps || steps.steps.length === 0) return;
    
    let md = `# Conversation: ${activeTitle}\n\n`;
    
    steps.steps.forEach(s => {
      const type = s.type || '';
      if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
        const text = (s.userInput?.items || []).filter(i => i.text).map(i => i.text).join('').trim();
        if (text) md += `**User**:\n\n${text}\n\n---\n\n`;
      } else if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
        const text = s.plannerResponse?.modifiedResponse || s.plannerResponse?.response || '';
        if (text) md += `**Assistant**:\n\n${text}\n\n---\n\n`;
      } else if (type === 'CORTEX_STEP_TYPE_TASK_BOUNDARY') {
        const tb = s.taskBoundary || {};
        md += `> **Task Boundary: ${tb.taskName || 'Task'}**\n`;
        if (tb.taskStatus) md += `> Status: ${tb.taskStatus}\n`;
        if (tb.taskSummary) md += `> ${tb.taskSummary}\n\n`;
      } else if (type === 'CORTEX_STEP_TYPE_NOTIFY_USER') {
        const text = s.notifyUser?.notificationContent || '';
        if (text) md += `**Assistant Notification**:\n\n${text}\n\n---\n\n`;
      }
    });

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTitle.replace(/[^a-zA-Z0-9-_\u4e00-\u9fa5]/g, '_')}_export.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [steps, activeTitle]);

  // isActive comes from the backend's trajectory summary — authoritative, not stale.
  const isRunning = isActive;

  return (
    <>
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onKnowledgeOpen={() => setKnowledgePanelOpen(true)}
        onLogsOpen={() => setLogViewerOpen(true)}
      />

      <main className="flex flex-col flex-1 min-w-0 h-dvh">
        {/* ── Branded Header ── */}
        <header className="flex items-center gap-4 px-6 h-14 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-10 shrink-0 shadow-sm">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden shrink-0 -ml-2"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold">
              A
            </div>
            <h1 className="text-sm font-semibold truncate hidden sm:block">{activeTitle}</h1>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {steps && steps.steps && steps.steps.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleExportMarkdown} className="h-9 text-xs font-medium">
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export MD
              </Button>
            )}
          </div>
        </header>

        {/* Chat Area */}
        <div className="flex-1 relative overflow-hidden bg-muted/20">
          <Chat steps={steps} loading={loading} currentModel={currentModel} onProceed={handleProceed} onRevert={handleRevert} />
          {sendError && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 bg-destructive text-destructive-foreground px-5 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-2 duration-300">
              {sendError}
            </div>
          )}
        </div>

        {/* Input Area */}
        {activeId && (
          <div className="shrink-0 z-10">
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
        )}
      </main>
    </div>
    <KnowledgePanel open={knowledgePanelOpen} onClose={() => setKnowledgePanelOpen(false)} />
    <LogViewerPanel open={logViewerOpen} onClose={() => setLogViewerOpen(false)} />
    <ActiveTasksPanel
      tasks={activeTasks.filter(t => !dismissedTasks.has(t.cascadeId))}
      onSelect={(id, title) => handleSelect(id, title)}
      onDismiss={(id) => setDismissedTasks(prev => new Set(prev).add(id))}
      activeCascadeId={activeId}
    />
    </>
  );
}
