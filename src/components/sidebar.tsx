'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Conversation, UserInfo, Skill, Workflow, Rule, Server, Workspace, AnalyticsData } from '@/lib/types';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Plus, ChevronRight, Puzzle, Zap, Gamepad2, MessageSquare, FolderOpen, ScrollText,
  Server as ServerIcon, Power, PowerOff, EyeOff, Eye, Loader2, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

interface SidebarProps {
  activeId: string | null;
  onSelect: (id: string, title: string) => void;
  onNew: (workspace: string) => void;
  open: boolean;
  onClose: () => void;
}

function getWorkspaceName(uri: string) {
  if (!uri) return 'Other';
  if (uri.includes('/playground/')) return 'Playground';
  const parts = uri.replace('file://', '').split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || uri;
}

export default function Sidebar({ activeId, onSelect, onNew, open, onClose }: SidebarProps) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedWs, setSelectedWs] = useState('');
  const [rules, setRules] = useState<Rule[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  // Launch dialog state
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const [launchTarget, setLaunchTarget] = useState('');
  const [launchStatus, setLaunchStatus] = useState<'idle' | 'launching' | 'polling' | 'ready' | 'error'>('idle');
  const [launchError, setLaunchError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Close workspace state
  const [closingWs, setClosingWs] = useState<string | null>(null);
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<string[]>([]);
  // Close (kill) confirmation dialog state
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState('');
  const [closeLoading, setCloseLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [u, c, s, w, sv, ws, r, hidden] = await Promise.all([
        api.me(), api.conversations(), api.skills(), api.workflows(), api.servers(), api.workspaces(), api.rules(),
        fetch('/api/workspaces/close').then(r => r.json()).catch(() => [] as string[]),
      ]);
      setUser(u); setConversations(c); setSkills(s); setWorkflows(w); setServers(sv);
      setWorkspaces(ws.workspaces || []);
      setRules(r || []);
      setHiddenWorkspaces(hidden || []);
      // Analytics loaded less frequently (separate call)
      api.analytics().then(a => setAnalytics(a)).catch(() => {});
    } catch { /* silent */ }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Check if a workspace URI has a running server
  const isWsRunning = useCallback((wsUri: string) => {
    if (wsUri === 'playground') return true;
    return servers.some(s => {
      const sw = s.workspace || '';
      return sw === wsUri || sw.includes(wsUri) || wsUri.includes(sw);
    });
  }, [servers]);

  // Handle "Start Conversation" with workspace check
  const handleStartConversation = useCallback(() => {
    if (!selectedWs) return;
    if (selectedWs === 'playground' || isWsRunning(selectedWs)) {
      onNew(selectedWs);
      onClose();
      return;
    }
    // Workspace not running — show launch dialog
    setLaunchTarget(selectedWs);
    setLaunchStatus('idle');
    setLaunchError('');
    setLaunchDialogOpen(true);
  }, [selectedWs, isWsRunning, onNew, onClose]);

  // Launch workspace and poll for server
  const handleLaunchWorkspace = useCallback(async (wsUri: string) => {
    setLaunchStatus('launching');
    setLaunchError('');
    try {
      await api.launchWorkspace(wsUri);
      setLaunchStatus('polling');
      // Poll for server to appear
      let elapsed = 0;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        elapsed += 2;
        if (elapsed > 30) {
          if (pollRef.current) clearInterval(pollRef.current);
          setLaunchStatus('error');
          setLaunchError('Timed out waiting for server to start. Please try again.');
          return;
        }
        try {
          const freshServers = await api.servers();
          const found = freshServers.some((s: Server) => {
            const sw = s.workspace || '';
            return sw === wsUri || sw.includes(wsUri) || wsUri.includes(sw);
          });
          if (found) {
            if (pollRef.current) clearInterval(pollRef.current);
            setLaunchStatus('ready');
            // Re-load sidebar data
            load();
          }
        } catch { /* ignore polling errors */ }
      }, 2000);
    } catch (e: any) {
      setLaunchStatus('error');
      setLaunchError(e.message || 'Failed to launch workspace');
    }
  }, [load]);

  // Hide workspace from sidebar (server stays running in background)
  const handleCloseWorkspace = useCallback(async (wsUri: string) => {
    setClosingWs(wsUri);
    try {
      await api.closeWorkspace(wsUri);
      load();
    } catch { /* silent */ }
    setClosingWs(null);
  }, [load]);

  // Unhide workspace
  const handleUnhideWorkspace = useCallback(async (wsUri: string) => {
    try {
      await fetch('/api/workspaces/close', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: wsUri }),
      });
      load();
    } catch { /* silent */ }
  }, [load]);

  // Close workspace completely (kill language_server)
  const handleKillWorkspace = useCallback(async (wsUri: string) => {
    setCloseLoading(true);
    try {
      await fetch('/api/workspaces/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: wsUri }),
      });
      setTimeout(() => { load(); setCloseLoading(false); setCloseDialogOpen(false); }, 2000);
    } catch {
      setCloseLoading(false);
    }
  }, [load]);

  // Helper: check if a workspace URI is hidden
  const isWsHidden = useCallback((wsUri: string) => {
    return hiddenWorkspaces.some(h => wsUri === h || wsUri.includes(h) || h.includes(wsUri));
  }, [hiddenWorkspaces]);

  const wsOptions = (() => {
    const allWs = new Map<string, { name: string; running: boolean; hidden: boolean }>();
    servers.forEach(s => {
      const ws = s.workspace || '';
      if (!ws || ws.includes('/playground/')) return;
      const isHidden = hiddenWorkspaces.some(h => ws === h || ws.includes(h) || h.includes(ws));
      allWs.set(ws, { name: ws.replace('file://', '').split('/').pop() || ws, running: true, hidden: isHidden });
    });
    workspaces.forEach(w => {
      const uri = w.uri || '';
      if (!uri || allWs.has(uri) || uri.includes('/playground/')) return;
      const isHidden = hiddenWorkspaces.some(h => uri === h || uri.includes(h) || h.includes(uri));
      allWs.set(uri, { name: uri.replace('file://', '').split('/').pop() || uri, running: false, hidden: isHidden });
    });
    return [...allWs.entries()].sort((a, b) => {
      if (a[1].hidden !== b[1].hidden) return a[1].hidden ? 1 : -1;
      if (a[1].running !== b[1].running) return a[1].running ? -1 : 1;
      return a[1].name.localeCompare(b[1].name);
    });
  })();

  // Filter out hidden workspaces from conversation list
  const visibleConversations = conversations.filter(c => !isWsHidden(c.workspace || ''));

  const groups: Record<string, Conversation[]> = {};
  visibleConversations.forEach(c => {
    const wsName = getWorkspaceName(c.workspace || '');
    if (!groups[wsName]) groups[wsName] = [];
    groups[wsName].push(c);
  });
  const sortedGroupNames = Object.keys(groups).sort((a, b) => {
    if (a === 'Playground') return 1;
    if (b === 'Playground') return -1;
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    return groups[b].length - groups[a].length;
  });

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onClose} />
      )}
      <aside className={cn(
        'flex flex-col h-dvh z-50 transition-transform duration-300 ease-out bg-background border-r',
        'w-[85vw] max-w-[320px] md:w-[320px] md:relative md:translate-x-0',
        'fixed top-0 left-0 md:static',
        open ? 'translate-x-0 shadow-xl' : '-translate-x-full md:translate-x-0',
      )}>
        {/* User Header */}
        <div className="flex items-center gap-3 p-4 shrink-0">
          <Avatar className="h-9 w-9">
            <AvatarFallback className="bg-primary text-primary-foreground font-bold">
              {user?.name?.[0]?.toUpperCase() || '?'}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col flex-1 min-w-0">
            <span className="text-sm font-semibold truncate leading-none mb-1">{user?.name || 'Loading...'}</span>
            <span className="text-xs text-muted-foreground truncate">{user?.email || ''}</span>
          </div>
        </div>
        
        <Separator className="shrink-0" />

        {/* New Conversation Actions */}
        <div className="p-4 space-y-3 shrink-0">
          <Select value={selectedWs} onValueChange={(val) => val && setSelectedWs(val)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select workspace" />
            </SelectTrigger>
            <SelectContent>

              {wsOptions.filter(([, info]) => !info.hidden).map(([uri, info]) => (
                <SelectItem key={uri} value={uri}>
                  <div className="flex items-center gap-2">
                    <div className={cn("w-2 h-2 rounded-full", info.running ? "bg-emerald-500" : "bg-muted-foreground/30")} />
                    {info.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="w-full" onClick={handleStartConversation}>
            <Plus className="mr-2 h-4 w-4" /> Start Conversation
          </Button>
        </div>

        <Separator className="shrink-0" />

        {/* Conversation List - ENSURE SCROLLING HERE */}
        <div className="flex-1 overflow-hidden min-h-0">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-6">
              {sortedGroupNames.map(wsName => (
                <div key={wsName} className="space-y-2">
                  <button
                    className="w-full flex items-center gap-2 text-[10px] font-bold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors group"
                    onClick={() => setCollapsed(p => ({ ...p, [wsName]: !p[wsName] }))}
                  >
                    <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', !collapsed[wsName] && 'rotate-90')} />
                    {wsName === 'Playground' ? <Gamepad2 className="w-3.5 h-3.5" /> : <FolderOpen className="w-3.5 h-3.5" />}
                    <span className="flex-1 text-left truncate">{wsName}</span>
                    <Badge variant="outline" className="px-1.5 py-0 min-w-5 h-5 justify-center opacity-60 font-mono">{groups[wsName].length}</Badge>
                  </button>

                  {!collapsed[wsName] && (
                    <div className="pl-3 space-y-0.5">
                      {groups[wsName].map(c => (
                        <Button
                          key={c.id}
                          variant="ghost"
                          className={cn(
                            "w-full justify-start font-normal h-8 px-2 text-sm rounded-md transition-all",
                            activeId === c.id ? "bg-secondary text-foreground font-semibold" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          )}
                          onClick={() => { onSelect(c.id, c.title); onClose(); }}
                        >
                          <MessageSquare className={cn("mr-2 h-3.5 w-3.5 shrink-0", activeId === c.id ? "text-indigo-500" : "text-muted-foreground/40")} />
                          <span className="truncate">{c.title || 'Untitled'}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>

        <Separator className="shrink-0" />

        {/* Bottom Tools Panel */}
        <div className="h-[260px] p-4 flex flex-col pt-2 shrink-0 bg-muted/20">
          <Tabs defaultValue="skills" className="w-full h-full flex flex-col">
            <TabsList className="w-full grid grid-cols-4 h-8 p-1 bg-background border">
              <TabsTrigger value="skills" className="text-[10px] font-bold">
                Skills
              </TabsTrigger>
              <TabsTrigger value="flows" className="text-[10px] font-bold">
                Flows
              </TabsTrigger>
              <TabsTrigger value="rules" className="text-[10px] font-bold">
                Rules
              </TabsTrigger>
              <TabsTrigger value="servers" className="text-[10px] font-bold">
                Servers
              </TabsTrigger>
            </TabsList>
            
            <div className="flex-1 overflow-hidden min-h-0 mt-3">
              <ScrollArea className="h-full">
                <TabsContent value="skills" className="m-0 space-y-4 pr-3">
                  {skills.length > 0 ? skills.map(s => (
                    <div key={s.name} className="space-y-1 group">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Puzzle className="w-3.5 h-3.5 text-indigo-500/70 shrink-0" />
                          <span className="text-xs font-semibold truncate group-hover:text-primary transition-colors">{s.name}</span>
                        </div>
                        <Badge variant="outline" className="text-[9px] uppercase h-4 px-1 shrink-0 opacity-50">{s.scope}</Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground pl-5 line-clamp-2 leading-tight">
                        {s.description}
                      </p>
                    </div>
                  )) : (
                    <div className="text-center text-[11px] text-muted-foreground py-8">No skills found</div>
                  )}
                </TabsContent>
                <TabsContent value="flows" className="m-0 space-y-4 pr-3">
                  {workflows.length > 0 ? workflows.map(w => (
                    <div key={w.name} className="space-y-1 group">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Zap className="w-3.5 h-3.5 text-amber-500/70 shrink-0" />
                          <span className="text-xs font-semibold truncate group-hover:text-primary transition-colors">/{w.name}</span>
                        </div>
                        {w.scope && <Badge variant="outline" className="text-[9px] uppercase h-4 px-1 shrink-0 opacity-50">{w.scope}</Badge>}
                      </div>
                      <p className="text-[11px] text-muted-foreground pl-5 line-clamp-2 leading-tight">
                        {w.description}
                      </p>
                    </div>
                  )) : (
                    <div className="text-center text-[11px] text-muted-foreground py-8">No workflows found</div>
                  )}
                </TabsContent>
                <TabsContent value="rules" className="m-0 space-y-4 pr-3">
                  {rules.length > 0 ? rules.map(r => (
                    <div key={r.path || r.name} className="space-y-1 group">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <ScrollText className="w-3.5 h-3.5 text-emerald-500/70 shrink-0" />
                          <span className="text-xs font-semibold truncate group-hover:text-primary transition-colors">{r.name || r.path.split('/').pop()}</span>
                        </div>
                        {r.scope && <Badge variant="outline" className="text-[9px] uppercase h-4 px-1 shrink-0 opacity-50">{r.scope}</Badge>}
                      </div>
                      {r.description && (
                        <p className="text-[11px] text-muted-foreground pl-5 line-clamp-2 leading-tight">
                          {r.description}
                        </p>
                      )}
                    </div>
                  )) : (
                    <div className="text-center text-[11px] text-muted-foreground py-8">No rules defined</div>
                  )}
                </TabsContent>
                <TabsContent value="servers" className="m-0 space-y-2.5 pr-3">
                  {wsOptions.length > 0 ? wsOptions.map(([uri, info]) => (
                    <div key={uri} className={cn("flex items-center gap-2 p-2 rounded-lg border bg-background group", info.hidden && "opacity-40")}>
                      <div className={cn("w-2 h-2 rounded-full shrink-0", info.running ? (info.hidden ? "bg-amber-500" : "bg-emerald-500") : "bg-muted-foreground/30")} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold truncate">{info.name}</div>
                        <div className="text-[10px] text-muted-foreground truncate">{uri.replace('file://', '')}</div>
                      </div>
                      {info.hidden ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                          onClick={() => handleUnhideWorkspace(uri)}
                          title="Show in sidebar"
                        >
                          <Eye className="h-3 w-3" />
                        </Button>
                      ) : info.running ? (
                        <div className="flex gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-foreground"
                            onClick={() => handleCloseWorkspace(uri)}
                            disabled={closingWs === uri}
                            title="Hide from sidebar (server stays running)"
                          >
                            {closingWs === uri ? <Loader2 className="h-3 w-3 animate-spin" /> : <EyeOff className="h-3 w-3" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive hover:text-destructive"
                            onClick={() => { setCloseTarget(uri); setCloseDialogOpen(true); }}
                            title="Close completely (stops language server)"
                          >
                            <PowerOff className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-emerald-600 hover:text-emerald-600"
                          onClick={() => handleLaunchWorkspace(uri)}
                        >
                          <Power className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  )) : (
                    <div className="text-center text-[11px] text-muted-foreground py-8">No workspaces found</div>
                  )}
                </TabsContent>
              </ScrollArea>
            </div>
          </Tabs>
        </div>

        {/* Launch Workspace Dialog */}
        <Dialog open={launchDialogOpen} onOpenChange={(open) => {
          if (!open) {
            if (pollRef.current) clearInterval(pollRef.current);
            setLaunchDialogOpen(false);
          }
        }}>
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ServerIcon className="h-5 w-5 text-amber-500" />
                Workspace Not Running
              </DialogTitle>
              <DialogDescription>
                <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                  {launchTarget.replace('file://', '').split('/').pop()}
                </span>
                {' '}is not currently open in Antigravity. Open it to start a conversation.
              </DialogDescription>
            </DialogHeader>

            <div className="py-2">
              {launchStatus === 'idle' && (
                <p className="text-sm text-muted-foreground">
                  This will open the workspace in a new Antigravity window and start its language server.
                </p>
              )}
              {launchStatus === 'launching' && (
                <div className="flex items-center gap-3 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
                  <span>Opening workspace...</span>
                </div>
              )}
              {launchStatus === 'polling' && (
                <div className="flex items-center gap-3 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                  <span>Waiting for language server to start...</span>
                </div>
              )}
              {launchStatus === 'ready' && (
                <div className="flex items-center gap-3 text-sm text-emerald-600">
                  <Power className="h-4 w-4" />
                  <span className="font-medium">Server is ready! You can now start a conversation.</span>
                </div>
              )}
              {launchStatus === 'error' && (
                <div className="text-sm text-destructive">{launchError}</div>
              )}
            </div>

            <DialogFooter>
              {launchStatus === 'idle' && (
                <>
                  <Button variant="outline" onClick={() => setLaunchDialogOpen(false)}>Cancel</Button>
                  <Button onClick={() => handleLaunchWorkspace(launchTarget)}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open in Antigravity
                  </Button>
                </>
              )}
              {(launchStatus === 'launching' || launchStatus === 'polling') && (
                <Button variant="outline" onClick={() => {
                  if (pollRef.current) clearInterval(pollRef.current);
                  setLaunchDialogOpen(false);
                }}>Cancel</Button>
              )}
              {launchStatus === 'ready' && (
                <Button onClick={() => {
                  setLaunchDialogOpen(false);
                  onNew(launchTarget);
                  onClose();
                }}>
                  <Plus className="mr-2 h-4 w-4" />
                  Start Conversation
                </Button>
              )}
              {launchStatus === 'error' && (
                <>
                  <Button variant="outline" onClick={() => setLaunchDialogOpen(false)}>Close</Button>
                  <Button onClick={() => handleLaunchWorkspace(launchTarget)}>Retry</Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Close Workspace Confirmation Dialog */}
        <Dialog open={closeDialogOpen} onOpenChange={(open) => { if (!open) setCloseDialogOpen(false); }}>
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <PowerOff className="h-5 w-5" />
                Close Workspace Completely
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-2">
                  <p>
                    This will <strong>stop the language server</strong> for{' '}
                    <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                      {closeTarget.replace('file://', '').split('/').pop()}
                    </span>.
                  </p>
                  <p className="text-amber-600 dark:text-amber-400 text-xs">
                    ⚠️ If this workspace is open in Agent Manager, Agent Manager will lose connection and show errors.
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCloseDialogOpen(false)} disabled={closeLoading}>Cancel</Button>
              <Button variant="destructive" onClick={() => handleKillWorkspace(closeTarget)} disabled={closeLoading}>
                {closeLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PowerOff className="mr-2 h-4 w-4" />}
                Close Completely
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </aside>
    </>
  );
}
