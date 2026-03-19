'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from '@/components/sidebar';
import Chat from '@/components/chat';
import ChatInput from '@/components/chat-input';
import { api, connectWs } from '@/lib/api';
import type { StepsData, ModelConfig, Skill, Workflow } from '@/lib/types';
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
  const wsRef = useRef<WebSocket | null>(null);
  const lastStepCountRef = useRef(0);

  useEffect(() => {
    api.models().then(d => {
      setModels(d.clientModelConfigs || []);
      // Auto-select a model if available and ours is totally fake
      if (d.clientModelConfigs?.length && currentModel === 'MODEL_PLACEHOLDER_M26') {
        const m = d.clientModelConfigs.find(x => x.label?.includes('3.5 Sonnet')) || d.clientModelConfigs[0];
        if (m.modelOrAlias?.model) setCurrentModel(m.modelOrAlias.model);
      }
    }).catch(() => {});
    api.skills().then(setSkills).catch(() => {});
    api.workflows().then(setWorkflows).catch(() => {});
  }, [currentModel]);

  useEffect(() => {
    wsRef.current = connectWs(
      (cascadeId, data, active, status) => {
        setActiveId(cur => {
          if (cur === cascadeId) {
            const newLen = data.steps?.length || 0;

            // Accept any update with steps >= last known count.
            // This allows: new steps (count grows), status changes, streaming text (same count).
            // Only reject if newLen < lastStepCountRef (stale data, see PITFALLS.md 坑 9).
            if (newLen > 0 && newLen >= lastStepCountRef.current) {
              lastStepCountRef.current = newLen;
              setSteps(data);
            }

            // Always update status signals
            setIsActive(active);
            setCascadeStatus(status);
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
    setActiveId(id);
    setActiveTitle(title || id.slice(0, 8));
    setSteps(null);
    loadSteps(id);
    if (wsRef.current?.readyState === 1) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', cascadeId: id }));
    }
  };

  const handleNew = async (workspace: string) => {
    try {
      const d = await api.createConversation(workspace);
      if (d.error) { alert(d.error); return; }
      if (d.cascadeId) handleSelect(d.cascadeId, 'New conversation');
    } catch (e: unknown) { alert('Failed: ' + (e instanceof Error ? e.message : 'unknown')); }
  };

  const handleSend = async (text: string) => {
    if (!activeId) return;
    try { await api.sendMessage(activeId, text, currentModel); } catch { /* */ }
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
    try { await api.revert(activeId, stepIndex, currentModel); } catch { /* */ }
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
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
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
        </div>

        {/* Input Area */}
        {activeId && (
          <div className="shrink-0 z-10">
            <ChatInput
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
            />
          </div>
        )}
      </main>
    </div>
  );
}
