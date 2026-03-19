import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import type { Step, StepsData } from '@/lib/types';
import { marked } from 'marked';
import { cn } from '@/lib/utils';
import {
  Eye, Search, Terminal, Globe, FolderOpen, AlertTriangle,
  FileCode, FilePen, Sparkles, ChevronDown, ExternalLink,
  CheckCircle2, XCircle, Clock, Wrench, Rocket, MessageCircle, RotateCcw,
  Trash2, Keyboard, MonitorPlay, FileSearch, Loader2, Ban
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ChatProps {
  steps: StepsData | null;
  loading: boolean;
  currentModel: string;
  onProceed?: (uri: string) => void;
  onRevert?: (stepIndex: number) => void;
  totalSteps?: number;
}

const TOOL_TYPES = new Set([
  'CORTEX_STEP_TYPE_CODE_ACTION',
  'CORTEX_STEP_TYPE_VIEW_FILE',
  'CORTEX_STEP_TYPE_GREP_SEARCH',
  'CORTEX_STEP_TYPE_RUN_COMMAND',
  'CORTEX_STEP_TYPE_SEARCH_WEB',
  'CORTEX_STEP_TYPE_LIST_DIRECTORY',
  'CORTEX_STEP_TYPE_FIND',
  'CORTEX_STEP_TYPE_COMMAND_STATUS',
  'CORTEX_STEP_TYPE_SEND_COMMAND_INPUT',
  'CORTEX_STEP_TYPE_BROWSER_SUBAGENT',
]);

const VISIBLE = new Set([
  'CORTEX_STEP_TYPE_USER_INPUT',
  'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  'CORTEX_STEP_TYPE_TASK_BOUNDARY',
  'CORTEX_STEP_TYPE_NOTIFY_USER',
  'CORTEX_STEP_TYPE_ERROR_MESSAGE',
  ...TOOL_TYPES,
]);

// Step status helpers
const isGenerating = (s?: string) => s === 'CORTEX_STEP_STATUS_GENERATING';
const isPending = (s?: string) => s === 'CORTEX_STEP_STATUS_PENDING';
const isRunning = (s?: string) => s === 'CORTEX_STEP_STATUS_RUNNING';
const isCanceled = (s?: string) => s === 'CORTEX_STEP_STATUS_CANCELED';
const isError = (s?: string) => s === 'CORTEX_STEP_STATUS_ERROR';

const modeStyles: Record<string, { label: string; bg: string; border: string; iconColor: string }> = {
  planning: { label: 'PLANNING', bg: 'bg-amber-500/10 text-amber-500', border: 'border-amber-500/30', iconColor: 'text-amber-500' },
  execution: { label: 'EXECUTION', bg: 'bg-indigo-500/10 text-indigo-500', border: 'border-indigo-500/30', iconColor: 'text-indigo-500' },
  verification: { label: 'VERIFICATION', bg: 'bg-emerald-500/10 text-emerald-500', border: 'border-emerald-500/30', iconColor: 'text-emerald-500' },
};

function renderMarkdown(text: string): string {
  try { return marked.parse(text, { async: false }) as string; }
  catch { return text; }
}

function getToolLabel(step: Step): { icon: React.ReactNode; text: string; statusIcon?: React.ReactNode } {
  const t = step.type || '';
  const status = step.status || '';

  // Status indicator
  let statusIcon: React.ReactNode = null;
  if (isPending(status)) statusIcon = <Clock className="w-3 h-3 text-muted-foreground animate-pulse" />;
  else if (isRunning(status) || isGenerating(status)) statusIcon = <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />;
  else if (isCanceled(status)) statusIcon = <Ban className="w-3 h-3 text-orange-400" />;
  else if (isError(status)) statusIcon = <XCircle className="w-3 h-3 text-destructive" />;

  if (t === 'CORTEX_STEP_TYPE_CODE_ACTION') {
    const ca = step.codeAction || {};
    const spec = ca.actionSpec || {};
    const isNew = !!spec.createFile;
    const isDel = !!spec.deleteFile;
    const file = (spec.createFile?.absoluteUri || spec.editFile?.absoluteUri || spec.deleteFile?.absoluteUri || '').split('/').pop() || '';
    return {
      icon: isDel ? <Trash2 className="w-3.5 h-3.5 text-red-500" /> : isNew ? <Sparkles className="w-3.5 h-3.5 text-emerald-500" /> : <FilePen className="w-3.5 h-3.5 text-indigo-500" />,
      text: `${isDel ? 'Delete' : isNew ? 'Create' : 'Edit'} ${file}`,
      statusIcon,
    };
  }
  if (t === 'CORTEX_STEP_TYPE_VIEW_FILE') {
    return { icon: <Eye className="w-3.5 h-3.5 text-zinc-400" />, text: `View ${(step.viewFile?.absoluteUri || '').split('/').pop() || 'file'}`, statusIcon };
  }
  if (t === 'CORTEX_STEP_TYPE_GREP_SEARCH') {
    const gs = step.grepSearch || {};
    return { icon: <Search className="w-3.5 h-3.5 text-zinc-400" />, text: `grep "${gs.query || gs.searchPattern || '...'}"`, statusIcon };
  }
  if (t === 'CORTEX_STEP_TYPE_RUN_COMMAND') {
    const cmd = step.runCommand?.command || step.runCommand?.commandLine || '';
    const safe = step.runCommand?.safeToAutoRun;
    return { icon: <Terminal className="w-3.5 h-3.5 text-emerald-500" />, text: `${safe ? '⚡ ' : ''}${cmd.slice(0, 60)}`, statusIcon };
  }
  if (t === 'CORTEX_STEP_TYPE_SEARCH_WEB') {
    return { icon: <Globe className="w-3.5 h-3.5 text-sky-500" />, text: `Search: ${step.searchWeb?.query || '...'}`, statusIcon };
  }
  if (t === 'CORTEX_STEP_TYPE_LIST_DIRECTORY') {
    return { icon: <FolderOpen className="w-3.5 h-3.5 text-amber-500/70" />, text: `ls ${(step.listDirectory?.path || '').split('/').pop() || '...'}`, statusIcon };
  }
  if (t === 'CORTEX_STEP_TYPE_FIND') {
    const f = step.find || {};
    return { icon: <FileSearch className="w-3.5 h-3.5 text-cyan-500" />, text: `find ${f.pattern || '...'} in ${(f.searchDirectory || '').split('/').pop() || '...'}`, statusIcon };
  }
  if (t === 'CORTEX_STEP_TYPE_COMMAND_STATUS') {
    return { icon: <Terminal className="w-3.5 h-3.5 text-zinc-400" />, text: `Command output`, statusIcon };
  }
  if (t === 'CORTEX_STEP_TYPE_SEND_COMMAND_INPUT') {
    return { icon: <Keyboard className="w-3.5 h-3.5 text-amber-400" />, text: `Send input`, statusIcon };
  }
  if (t === 'CORTEX_STEP_TYPE_BROWSER_SUBAGENT') {
    const bs = step.browserSubagent || {};
    return { icon: <MonitorPlay className="w-3.5 h-3.5 text-purple-500" />, text: `Browser: ${bs.taskName || bs.task?.slice(0, 40) || '...'}`, statusIcon };
  }
  return { icon: <Wrench className="w-3.5 h-3.5" />, text: 'action', statusIcon };
}

function ToolGroup({ steps }: { steps: Step[] }) {
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 1) {
    const { icon, text, statusIcon } = getToolLabel(steps[0]);
    return (
      <div className={cn('flex items-center gap-3 px-3 py-1.5 mb-1 max-w-2xl bg-muted/20 rounded-md border text-[11px] text-muted-foreground ml-[52px]', isCanceled(steps[0].status) && 'opacity-40 line-through')}>
        <div className="shrink-0">{icon}</div>
        <span className="truncate font-mono flex-1">{text}</span>
        {statusIcon}
      </div>
    );
  }

  return (
    <div className="mb-2 max-w-2xl ml-[52px]">
      <Button
        variant="ghost"
        className="w-full justify-start gap-3 h-8 px-3 text-muted-foreground hover:text-foreground bg-muted/10 border border-transparent hover:border-border transition-all"
        onClick={() => setExpanded(!expanded)}
      >
        <Wrench className="w-3.5 h-3.5" />
        <span className="font-semibold text-[11px] uppercase tracking-wider">{steps.length} actions</span>
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform ml-auto', expanded && 'rotate-180')} />
      </Button>
      {expanded && (
        <div className="mt-1 space-y-1">
          {steps.map((s, i) => {
            const { icon, text, statusIcon } = getToolLabel(s);
            return (
              <div key={i} className={cn('flex items-center gap-3 px-3 py-1.5 text-[11px] text-muted-foreground bg-background/50 rounded-md border border-dashed hover:border-solid transition-all', isCanceled(s.status) && 'opacity-40 line-through')}>
                <div className="shrink-0">{icon}</div>
                <span className="truncate font-mono flex-1">{text}</span>
                {statusIcon}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type RenderItem = { type: 'step'; step: Step; originalIndex: number } | { type: 'tools'; steps: Step[] };

function groupSteps(taggedSteps: { step: Step; originalIndex: number }[]): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: Step[] = [];

  function flushTools() {
    if (toolBuf.length > 0) {
      items.push({ type: 'tools', steps: [...toolBuf] });
      toolBuf = [];
    }
  }

  for (const t of taggedSteps) {
    if (TOOL_TYPES.has(t.step.type || '')) {
      toolBuf.push(t.step);
    } else {
      flushTools();
      items.push({ type: 'step', step: t.step, originalIndex: t.originalIndex });
    }
  }
  flushTools();
  return items;
}

function StepBubble({ step, originalIndex, totalSteps, allSteps, onProceed, onRevert }: { step: Step; originalIndex: number; totalSteps: number; allSteps: Step[]; onProceed?: (uri: string) => void; onRevert?: (stepIndex: number) => void }) {
  const type = step.type || '';

  if (type === 'CORTEX_STEP_TYPE_USER_INPUT') {
    const items = step.userInput?.items || [];
    const text = items.filter(i => i.text).map(i => i.text).join('').trim();
    if (!text) return null;
    return (
      <div className="flex justify-end mt-8 mb-6 max-w-4xl mx-auto w-full px-4 sm:px-6 group">
        <div className="flex gap-4 max-w-[85%] sm:max-w-[70%] items-start justify-end">
          {onRevert && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1 shrink-0"
              onClick={() => onRevert(originalIndex)}
              title="Revert to this message"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
          <div className="bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-5 py-3.5 text-sm leading-relaxed shadow-sm">
            <div className="whitespace-pre-wrap">{text}</div>
          </div>
          <Avatar className="h-8 w-8 shrink-0 border bg-background mt-1 hidden sm:flex">
            <AvatarFallback className="bg-zinc-800 text-white text-[10px] font-bold">USER</AvatarFallback>
          </Avatar>
        </div>
      </div>
    );
  }

  if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
    const pr = step.plannerResponse || {};
    const text = pr.modifiedResponse || pr.response || '';
    const streaming = isGenerating(step.status);
    // Show streaming text even if short; only hide empty DONE responses
    if (!streaming && (!text || text.length < 3)) return null;
    return (
      <div className="flex mt-8 mb-4 max-w-4xl mx-auto w-full px-4 sm:px-6 group">
        <div className="flex gap-4 max-w-full items-start w-full">
          <Avatar className="h-8 w-8 shrink-0 border bg-background mt-1">
            <AvatarFallback className="bg-indigo-600 text-white text-[10px] font-bold">AI</AvatarFallback>
          </Avatar>
          <div className="flex-1 bg-card border rounded-2xl rounded-tl-sm px-6 py-5 text-[15px] leading-relaxed chat-markdown shadow-xs overflow-x-auto min-w-0">
            {text ? (
              <div dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
            ) : streaming ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Thinking...</span>
              </div>
            ) : null}
            {streaming && text && (
              <span className="inline-block w-0.5 h-5 bg-indigo-500 animate-pulse ml-0.5 align-text-bottom" />
            )}
          </div>
          {!streaming && onRevert && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1 shrink-0"
              onClick={() => onRevert(originalIndex)}
              title="Revert to this message"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (type === 'CORTEX_STEP_TYPE_TASK_BOUNDARY') {
    const tb = step.taskBoundary || {};
    const mode = (tb.mode || '').replace('AGENT_MODE_', '').toLowerCase();
    const ms = modeStyles[mode] || modeStyles.execution;
    return (
      <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 my-10 pl-[52px]">
        <div className={cn('border-l-2 pl-6 py-1', ms.border)}>
          <div className="flex items-center gap-3">
            <span className={cn('text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-widest', ms.bg)}>
              {ms.label}
            </span>
            <span className="font-bold text-sm tracking-tight">{tb.taskName || 'Task Update'}</span>
          </div>
          {tb.taskStatus && <div className="text-[13px] text-muted-foreground mt-2 font-medium">{tb.taskStatus}</div>}
          {tb.taskSummary && (
            <div className="text-[12px] text-muted-foreground/80 mt-3 leading-relaxed max-w-2xl bg-muted/10 p-4 rounded-lg border border-dashed">
              {tb.taskSummary}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (type === 'CORTEX_STEP_TYPE_NOTIFY_USER') {
    const nu = step.notifyUser || {};
    const content = nu.notificationContent || '';
    // Use rich fields from gRPC, with fallbacks to legacy fields
    const blocked = nu.blockedOnUser ?? nu.isBlocking ?? false;
    const reviewPaths = nu.pathsToReview || nu.reviewAbsoluteUris || [];
    const autoProc = nu.shouldAutoProceed ?? false;
    const hasFollowup = allSteps.slice(originalIndex + 1).some(s => s.type === 'CORTEX_STEP_TYPE_USER_INPUT');
    return (
      <div className="flex mt-8 mb-6 max-w-4xl mx-auto w-full px-4 sm:px-6">
        <div className="flex gap-4 max-w-full items-start w-full">
          <Avatar className="h-8 w-8 shrink-0 border bg-background mt-1">
            <AvatarFallback className="bg-indigo-600 text-white text-[10px] font-bold">AI</AvatarFallback>
          </Avatar>
          <div className="flex-1 bg-card border rounded-2xl rounded-tl-sm px-6 py-5 shadow-xs">
            {content && (
              <div className="chat-markdown text-[15px] leading-relaxed mb-4" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
            )}
            {reviewPaths.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                {reviewPaths.map(uri => {
                  const name = uri.replace('file://', '').split('/').pop();
                  return (
                    <Card key={uri} className="bg-muted/30 hover:bg-muted/50 transition-colors shadow-none border-dashed cursor-pointer" onClick={() => window.open(uri, '_blank')}>
                      <div className="flex items-center justify-between p-3">
                        <div className="flex items-center gap-3 min-w-0 pr-2">
                          <FileCode className="h-4 w-4 text-indigo-500 shrink-0" />
                          <span className="text-xs font-semibold truncate">{name}</span>
                        </div>
                        <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Blocking approval section */}
            {blocked && !hasFollowup && (
              <div className="mt-8 p-5 rounded-xl border-l-4 border-l-amber-500 border bg-amber-500/[0.03] space-y-4">
                <div className="flex items-center gap-3 text-amber-600 dark:text-amber-500">
                  <Clock className="w-4 h-4 animate-pulse" />
                  <span className="text-sm font-bold uppercase tracking-wider">
                    {autoProc ? 'Auto-proceeding' : 'Approval Required'}
                  </span>
                </div>
                {!autoProc && (
                  <div className="flex gap-3">
                    <Button onClick={() => onProceed?.(reviewPaths[0] || '')} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold h-10 shadow-lg shadow-indigo-500/10">
                      <CheckCircle2 className="w-4 h-4 mr-2" /> Proceed
                    </Button>
                    <Button variant="outline" className="flex-1 border-zinc-500/20 hover:bg-zinc-500/5 font-bold h-10">
                      <XCircle className="w-4 h-4 mr-2" /> Reject
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Auto-proceed indicator (when already proceeded) */}
            {autoProc && hasFollowup && (
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                <span>Auto-proceeded</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE') {
    const em = step.errorMessage || {};
    return (
      <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 my-6 pl-[52px]">
        <div className="inline-flex items-center gap-3 text-sm font-medium text-destructive bg-destructive/5 border border-destructive/20 rounded-full px-5 py-2.5">
          <AlertTriangle className="w-4 h-4" />
          <span className="truncate">{em.message || em.errorMessage || 'Error occurred'}</span>
        </div>
      </div>
    );
  }

  return null;
}

export default function Chat({ steps, loading, onProceed, onRevert, totalSteps: totalStepsProp }: ChatProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const renderItems = useMemo(() => {
    if (!steps?.steps) return [];
    const visible = steps.steps
      .map((s, idx) => ({ step: s, originalIndex: idx }))
      .filter(x => VISIBLE.has(x.step.type || ''));
    return groupSteps(visible);
  }, [steps]);

  const totalSteps = steps?.steps?.length || 0;
  const allSteps = steps?.steps || [];

  // Robust auto-scroll to bottom
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  // Scroll on initial load and message updates
  useEffect(() => {
    if (renderItems.length > 0) {
      // Small timeout to ensure DOM is ready
      const timer = setTimeout(() => scrollToBottom('smooth'), 100);
      return () => clearTimeout(timer);
    }
  }, [renderItems, scrollToBottom]);

  if (!steps && !loading) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-20 h-20 rounded-[2rem] bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-10 shadow-xl shadow-indigo-500/5">
          <Rocket className="w-10 h-10 text-indigo-500" />
        </div>
        <h2 className="text-3xl font-extrabold tracking-tight mb-4">Antigravity Gateway</h2>
        <p className="text-muted-foreground text-base mb-10 max-w-sm leading-relaxed">Agent development interface powered by Google DeepMind Advanced Coding.</p>
        <div className="flex gap-6">
          <div className="flex flex-col items-center gap-3 opacity-60">
            <div className="w-12 h-12 rounded-xl border border-dashed flex items-center justify-center">
              <span className="font-mono text-xs">/</span>
            </div>
            <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Skills</span>
          </div>
          <div className="flex flex-col items-center gap-3 opacity-60">
            <div className="w-12 h-12 rounded-xl border border-dashed flex items-center justify-center">
              <span className="font-mono text-xs">@</span>
            </div>
            <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Files</span>
          </div>
        </div>
      </div>
    );
  }

  if (loading && !steps) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 text-muted-foreground">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="text-xs font-bold uppercase tracking-widest">Initialising session</span>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="py-12 min-h-full flex flex-col" ref={viewportRef}>
        {renderItems.map((item, i) =>
          item.type === 'tools'
            ? <div className="max-w-4xl mx-auto w-full px-4 sm:px-6" key={i}><ToolGroup steps={item.steps} /></div>
            : <StepBubble key={i} step={item.step} originalIndex={item.originalIndex} totalSteps={totalSteps} allSteps={allSteps} onProceed={onProceed} onRevert={onRevert} />
        )}
        <div ref={bottomRef} className="h-4 w-full shrink-0" />
      </div>
    </ScrollArea>
  );
}
