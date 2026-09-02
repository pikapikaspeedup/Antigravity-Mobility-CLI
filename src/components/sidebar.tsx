'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  AgentRun,
  Conversation,
  KnowledgeItem,
  Rule,
  Server,
  Skill,
  HubProject,
  Project,
  UserInfo,
  Workflow,
} from '@/lib/types';
import { useI18n } from '@/components/locale-provider';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

import { formatRelativeTime } from '@/lib/i18n/formatting';
import { getAgentRunTimeAgo, getAgentRunWorkspaceName, isAgentRunActive } from '@/lib/agent-run-utils';
import {
  BookOpen,
  Bot,
  ChevronRight,
  MessageSquare,
  Plus,
  Puzzle,
  ScrollText,
  Sparkles,
  FolderKanban,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ModeTabs } from '@/components/ui/app-shell';

type SidebarSection = 'conversations' | 'projects' | 'agents' | 'knowledge';

interface SidebarProps {
  activeId: string | null;
  onSelect: (id: string, title: string) => void;
  onNew: (projectId: string) => void;
  open: boolean;
  onClose: () => void;
  currentModelLabel: string;
  activeRunsCount?: number;
  agentRuns?: AgentRun[];
  selectedAgentRunId?: string | null;
  onSelectAgentRun?: (runId: string) => void;
  selectedKnowledgeId?: string | null;
  onSelectKnowledge?: (id: string, title: string) => void;
  knowledgeRefreshSignal?: number;
  section: SidebarSection;
  onSectionChange?: (section: SidebarSection) => void;
  projects?: Project[];
  selectedProjectId?: string | null;
  onSelectProject?: (id: string) => void;
}

function RailItem({
  icon,
  title,
  meta,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        'group w-full rounded-[20px] border px-4 py-3 text-left transition-all',
        active
          ? 'border-[var(--app-border-strong)] bg-[linear-gradient(135deg,rgba(88,243,212,0.12),rgba(12,20,34,0.9))] shadow-[0_18px_42px_rgba(0,0,0,0.24)]'
          : 'border-white/6 bg-white/[0.025] hover:border-white/10 hover:bg-white/[0.05]',
      )}
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <div className="mt-1 shrink-0 text-[var(--app-text-muted)] group-hover:text-[var(--app-text)]">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn('line-clamp-2 text-sm leading-6', active ? 'font-semibold text-white' : 'text-white/88')}>
            {title}
          </div>
          {meta ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--app-text-soft)]">
              {meta}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--app-text-muted)]">{children}</div>;
}

export default function Sidebar({
  activeId,
  onSelect,
  onNew,
  open,
  onClose,
  currentModelLabel,
  activeRunsCount = 0,
  agentRuns = [],
  selectedAgentRunId = null,
  onSelectAgentRun,
  selectedKnowledgeId = null,
  onSelectKnowledge,
  knowledgeRefreshSignal = 0,
  section,
  onSectionChange,
  projects = [],
  selectedProjectId = null,
  onSelectProject,
}: SidebarProps) {
  const { locale, t } = useI18n();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [hubProjects, setHubProjects] = useState<HubProject[]>([]);
  const [selectedHubProjectId, setSelectedHubProjectId] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [resourcesOpen, setResourcesOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextUser, nextConversations, nextKnowledge, nextSkills, nextWorkflows, nextServers, nextRules, nextHubProjects] = await Promise.all([
        api.me(),
        api.conversations(),
        api.knowledge(),
        api.skills(),
        api.workflows(),
        api.servers(),
        api.rules(),
        api.hubProjects(),
      ]);

      setUser(nextUser);
      setConversations(nextConversations);
      setKnowledgeItems(nextKnowledge);
      setSkills(nextSkills);
      setWorkflows(nextWorkflows);
      setServers(nextServers);
      setRules(nextRules || []);
      setHubProjects(nextHubProjects || []);
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void load();
    }, 0);
    const timer = window.setInterval(() => {
      void load();
    }, 8000);

    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(timer);
    };
  }, [load, knowledgeRefreshSignal]);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('antigravity_selected_project') : '';
    if (saved) setSelectedHubProjectId(saved);
  }, []);

  useEffect(() => {
    if (!hubProjects.length) return;
    if (selectedHubProjectId && hubProjects.some(p => p.id === selectedHubProjectId)) return;
    setSelectedHubProjectId(hubProjects[0].id);
  }, [hubProjects, selectedHubProjectId]);

  useEffect(() => {
    if (selectedHubProjectId && typeof window !== 'undefined') {
      localStorage.setItem('antigravity_selected_project', selectedHubProjectId);
    }
  }, [selectedHubProjectId]);

  const selectedHubProject = hubProjects.find(p => p.id === selectedHubProjectId) || null;

  const handleStartConversation = () => {
    if (!selectedHubProjectId) return;
    onNew(selectedHubProjectId);
    onClose();
  };

  const handleCreateFromFolder = async () => {
    if (!folderPath.trim()) return;
    setCreatingProject(true);
    setProjectError('');
    try {
      const created = await api.createHubProject(folderPath.trim());
      if (created.error) {
        setProjectError(created.error);
        return;
      }
      setHubProjects(prev => prev.some(p => p.id === created.id) ? prev : [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedHubProjectId(created.id);
      setFolderPath('');
    } catch (error: unknown) {
      setProjectError(error instanceof Error ? error.message : t('chat.errorOccurred'));
    } finally {
      setCreatingProject(false);
    }
  };

  const visibleConversations = [...conversations].sort((a, b) => b.mtime - a.mtime);
  const activeAgentRuns = agentRuns.filter(run => isAgentRunActive(run.status));
  const recentAgentRuns = agentRuns.filter(run => !isAgentRunActive(run.status));
  const sortedKnowledgeItems = [...knowledgeItems].sort((a, b) => {
    return new Date(b.timestamps.accessed).getTime() - new Date(a.timestamps.accessed).getTime();
  });

  const sectionTitle =
    section === 'agents'
      ? t('shell.agents')
      : section === 'knowledge'
        ? t('shell.knowledge')
        : t('shell.chats');
  const sectionCount =
    section === 'projects'
      ? projects.length
      : section === 'agents'
      ? agentRuns.length
      : section === 'knowledge'
        ? knowledgeItems.length
        : visibleConversations.length;

  return (
    <>
      {open ? (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={onClose} />
      ) : null}

      <aside
        className={cn(
          'fixed left-0 top-0 z-50 flex h-dvh flex-col overflow-hidden border-r border-white/6 bg-[var(--agent-shell)] text-foreground transition-transform duration-300 ease-out md:static md:translate-x-0',
          'w-[85vw] max-w-[320px] md:relative md:w-[320px]',
          open ? 'translate-x-0 shadow-xl' : '-translate-x-full md:translate-x-0',
        )}
      >
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 agent-stage opacity-80" />
          <div className="absolute inset-0 agent-grid opacity-25" />
          <div className="absolute -left-10 top-24 h-36 w-36 rounded-full bg-[radial-gradient(circle,rgba(88,243,212,0.14),transparent_70%)] blur-2xl" />
          <div className="absolute bottom-24 right-[-40px] h-44 w-44 rounded-full bg-[radial-gradient(circle,rgba(245,183,76,0.12),transparent_72%)] blur-3xl" />
        </div>

        <div className="relative flex items-center gap-3 px-4 pb-4 pt-5">
          <Avatar className="h-11 w-11 border border-white/8 shadow-[0_10px_30px_rgba(0,0,0,0.25)]">
            <AvatarFallback className="bg-white text-slate-950 font-semibold">
              {user?.name?.[0]?.toUpperCase() || '?'}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold leading-none">{user?.name || t('shell.profileLoading')}</div>
            <div className="mt-1 truncate text-xs text-[var(--agent-text-soft)]">{user?.email || ''}</div>
          </div>
        </div>

        <Separator className="bg-white/6" />

        <div className="relative space-y-3 px-4 py-4">
          <ModeTabs
            value={section}
            onValueChange={(value) => onSectionChange?.(value as SidebarSection)}
            fill
            className="w-full"
            tabs={[
              { value: 'conversations', label: t('shell.chats'), icon: <MessageSquare className="h-4 w-4" /> },
              { value: 'projects', label: 'Projects', icon: <FolderKanban className="h-4 w-4" /> },
              { value: 'agents', label: t('shell.agents'), icon: <Bot className="h-4 w-4" /> },
              { value: 'knowledge', label: t('shell.knowledge'), icon: <BookOpen className="h-4 w-4" /> },
            ]}
          />


          {section === 'conversations' ? (
            <div className="rounded-[24px] border border-white/6 bg-[linear-gradient(180deg,rgba(18,30,49,0.92),rgba(13,22,36,0.94))] p-4 shadow-[var(--panel-shadow)]">
              <div className="space-y-3">
                {hubProjects.length > 0 ? (
                  <>
                    <Select value={selectedHubProjectId} onValueChange={(value) => value && setSelectedHubProjectId(value)}>
                      <SelectTrigger className="h-12 rounded-[18px] border-white/8 bg-white/[0.04] text-sm">
                        <SelectValue placeholder={t('sidebar.selectProject')} />
                      </SelectTrigger>
                      <SelectContent>
                        {hubProjects.map(project => (
                          <SelectItem key={project.id} value={project.id}>
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate">{project.name}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedHubProject ? (
                      <div className="space-y-1 text-[11px] text-[var(--agent-text-soft)]">
                        {selectedHubProject.folders.map(folder => (
                          <div key={folder.uri} className="truncate" title={folder.path}>
                            <span className={folder.allowWrite ? 'text-emerald-400' : 'text-amber-400'}>
                              {folder.allowWrite ? t('sidebar.writable') : t('sidebar.readonly')}
                            </span>
                            {' · '}
                            {folder.path}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <Button
                      className="h-12 w-full rounded-[18px] border-0 bg-[linear-gradient(135deg,#58f3d4,#33c2ff)] text-sm font-semibold text-slate-950 shadow-[0_20px_50px_rgba(22,163,200,0.22)] transition-transform hover:-translate-y-0.5 hover:shadow-[0_24px_60px_rgba(22,163,200,0.28)]"
                      onClick={handleStartConversation}
                      disabled={!selectedHubProjectId}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      {t('sidebar.startConversation')}
                    </Button>
                  </>
                ) : (
                  <div className="text-sm leading-6 text-[var(--agent-text-soft)]">
                    {t('sidebar.noProjectsBody')}
                  </div>
                )}
                <div className="space-y-2 border-t border-white/6 pt-3">
                  <Input
                    value={folderPath}
                    onChange={(event) => setFolderPath(event.target.value)}
                    placeholder={t('sidebar.folderPathPlaceholder')}
                    className="h-10 rounded-[14px] border-white/8 bg-white/[0.04] text-xs"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleCreateFromFolder();
                    }}
                  />
                  <Button
                    variant="outline"
                    className="h-10 w-full rounded-[14px] border-white/10 bg-white/[0.03] text-xs"
                    onClick={() => { void handleCreateFromFolder(); }}
                    disabled={creatingProject || !folderPath.trim()}
                  >
                    {creatingProject ? t('common.loading') : t('sidebar.createFromFolder')}
                  </Button>
                  {projectError ? <div className="text-[11px] text-destructive">{projectError}</div> : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <Separator className="bg-white/6" />

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="space-y-5 p-4">
              {section === 'conversations' ? (
                visibleConversations.length > 0 ? (
                  <div className="space-y-1">
                    {visibleConversations.map(conversation => (
                      <RailItem
                        key={conversation.id}
                        icon={<MessageSquare className="h-4 w-4" />}
                        title={conversation.title || t('sidebar.untitled')}
                        meta={(
                          <>
                            {conversation.projectName ? <span>{conversation.projectName}</span> : null}
                            {conversation.steps > 0 && (
                              <span>{conversation.steps} steps</span>
                            )}
                            <span>{formatRelativeTime(new Date(conversation.mtime).toISOString(), locale)}</span>
                          </>
                        )}
                        active={activeId === conversation.id}
                        onClick={() => {
                          onSelect(conversation.id, conversation.title);
                          onClose();
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[20px] border border-dashed border-white/10 px-4 py-8 text-center text-sm text-[var(--app-text-soft)]">
                    {t('sidebar.noConversations')}
                  </div>
                )
              ) : null}

              {section === 'projects' ? (
                projects.length > 0 ? (
                  <div className="space-y-2">
                    {projects.map(project => (
                      <RailItem
                        key={project.projectId}
                        icon={<FolderKanban className="h-4 w-4" />}
                        title={project.name}
                        meta={(
                          <>
                            <Badge variant="outline" className="h-5 rounded-full border-white/10 bg-white/[0.04] px-2 text-[10px]">
                              {project.status}
                            </Badge>
                            <span>{formatRelativeTime(project.createdAt, locale)}</span>
                          </>
                        )}
                        active={selectedProjectId === project.projectId}
                        onClick={() => {
                          onSelectProject?.(project.projectId);
                          onClose();
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[20px] border border-dashed border-white/10 px-4 py-8 text-center text-sm text-[var(--app-text-soft)]">
                    No projects found
                  </div>
                )
              ) : null}

              {section === 'agents' ? (
                agentRuns.length > 0 ? (
                  <div className="space-y-5">
                    {activeAgentRuns.length > 0 ? (
                      <div className="space-y-2">
                        <SectionLabel>{t('sidebar.active')}</SectionLabel>
                        {activeAgentRuns.map(run => (
                          <RailItem
                            key={run.runId}
                            icon={<Bot className="h-4 w-4" />}
                            title={run.prompt}
                            meta={(
                              <>
                                <Badge variant="outline" className="h-5 rounded-full border-white/10 bg-white/[0.04] px-2 text-[10px]">
                                  {getAgentRunWorkspaceName(run.workspace)}
                                </Badge>
                                <span>{getAgentRunTimeAgo(run.createdAt, locale)}</span>
                              </>
                            )}
                            active={selectedAgentRunId === run.runId}
                            onClick={() => {
                              onSelectAgentRun?.(run.runId);
                              onClose();
                            }}
                          />
                        ))}
                      </div>
                    ) : null}

                    {recentAgentRuns.length > 0 ? (
                      <div className="space-y-2">
                        <SectionLabel>{t('sidebar.recent')}</SectionLabel>
                        {recentAgentRuns.map(run => (
                          <RailItem
                            key={run.runId}
                            icon={<Sparkles className="h-4 w-4" />}
                            title={run.prompt}
                            meta={(
                              <>
                                <Badge variant="outline" className="h-5 rounded-full border-white/10 bg-white/[0.04] px-2 text-[10px]">
                                  {getAgentRunWorkspaceName(run.workspace)}
                                </Badge>
                                <span>{getAgentRunTimeAgo(run.createdAt, locale)}</span>
                              </>
                            )}
                            active={selectedAgentRunId === run.runId}
                            onClick={() => {
                              onSelectAgentRun?.(run.runId);
                              onClose();
                            }}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-[20px] border border-dashed border-white/10 px-4 py-8 text-center text-sm text-[var(--app-text-soft)]">
                    {t('sidebar.noRunsYet')}
                  </div>
                )
              ) : null}

              {section === 'knowledge' ? (
                sortedKnowledgeItems.length > 0 ? (
                  <div className="space-y-2">
                    {sortedKnowledgeItems.map(item => (
                      <RailItem
                        key={item.id}
                        icon={<BookOpen className="h-4 w-4" />}
                        title={item.title}
                        meta={(
                          <>
                            <Badge variant="outline" className="h-5 rounded-full border-white/10 bg-white/[0.04] px-2 text-[10px]">
                              {item.artifactFiles.length} {t('knowledge.artifacts')}
                            </Badge>
                            <span>{formatRelativeTime(item.timestamps.accessed, locale)}</span>
                          </>
                        )}
                        active={selectedKnowledgeId === item.id}
                        onClick={() => {
                          onSelectKnowledge?.(item.id, item.title);
                          onClose();
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[20px] border border-dashed border-white/10 px-4 py-8 text-center text-sm text-[var(--app-text-soft)]">
                    {t('knowledge.noItems')}
                  </div>
                )
              ) : null}
            </div>
          </ScrollArea>
        </div>

        <Separator className="bg-white/6" />

        <Collapsible open={resourcesOpen} onOpenChange={setResourcesOpen} className="relative shrink-0">
          <CollapsibleTrigger className="mx-3 mb-3 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-[22px] border border-white/6 bg-white/[0.03] px-4 py-3 text-left transition-colors hover:bg-white/[0.05]">
            <div className="min-w-0 flex-1">
              <div className="app-eyebrow">{t('shell.resources')}</div>
              <div className="truncate text-xs text-[var(--agent-text-soft)]">{t('sidebar.resourcesBody')}</div>
            </div>
            <Badge variant="outline" className="h-5 rounded-full border-white/10 bg-black/10 px-1.5 text-[10px]">
              4
            </Badge>
            <ChevronRight className={cn('h-4 w-4 text-[color:var(--agent-text-muted)] transition-transform', resourcesOpen && 'rotate-90')} />
          </CollapsibleTrigger>

          <CollapsibleContent className="mx-3 mb-3 rounded-[24px] border border-white/6 bg-white/[0.02]">
            <div className="p-4">
              <Tabs defaultValue="skills" className="flex w-full flex-col">
                <TabsList className="grid h-10 w-full grid-cols-4 border-white/6 bg-white/[0.03] p-1">
                  <TabsTrigger value="skills" className="text-[10px] font-semibold data-[state=active]:bg-[var(--app-accent-soft)]">
                    {t('sidebar.skills')}
                  </TabsTrigger>
                  <TabsTrigger value="flows" className="text-[10px] font-semibold data-[state=active]:bg-[var(--app-accent-soft)]">
                    {t('sidebar.flows')}
                  </TabsTrigger>
                  <TabsTrigger value="rules" className="text-[10px] font-semibold data-[state=active]:bg-[var(--app-accent-soft)]">
                    {t('sidebar.rules')}
                  </TabsTrigger>
                  <TabsTrigger value="servers" className="text-[10px] font-semibold data-[state=active]:bg-[var(--app-accent-soft)]">
                    {t('sidebar.servers')}
                  </TabsTrigger>
                </TabsList>

                <div className="mt-3 h-[240px] overflow-hidden">
                  <ScrollArea className="h-[240px] pr-3">
                    <TabsContent value="skills" className="m-0 space-y-4">
                      {skills.length > 0 ? skills.map(skill => (
                        <div key={skill.name} className="space-y-1">
                          <div className="flex items-start gap-2">
                            <Puzzle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
                            <div className="min-w-0">
                              <div className="truncate text-xs font-semibold">{skill.name}</div>
                              <div className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{skill.description}</div>
                            </div>
                          </div>
                        </div>
                      )) : <div className="py-8 text-center text-[11px] text-muted-foreground">{t('sidebar.noSkills')}</div>}
                    </TabsContent>

                    <TabsContent value="flows" className="m-0 space-y-4">
                      {workflows.length > 0 ? workflows.map(workflow => (
                        <div key={workflow.name} className="space-y-1">
                          <div className="flex items-start gap-2">
                            <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                            <div className="min-w-0">
                              <div className="truncate text-xs font-semibold">/{workflow.name}</div>
                              <div className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{workflow.description}</div>
                            </div>
                          </div>
                        </div>
                      )) : <div className="py-8 text-center text-[11px] text-muted-foreground">{t('sidebar.noFlows')}</div>}
                    </TabsContent>

                    <TabsContent value="rules" className="m-0 space-y-4">
                      {rules.length > 0 ? rules.map(rule => (
                        <div key={rule.path || rule.name} className="space-y-1">
                          <div className="flex items-start gap-2">
                            <ScrollText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                            <div className="min-w-0">
                              <div className="truncate text-xs font-semibold">{rule.name || rule.path.split('/').pop()}</div>
                              {rule.description ? (
                                <div className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{rule.description}</div>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      )) : <div className="py-8 text-center text-[11px] text-muted-foreground">{t('sidebar.noRules')}</div>}
                    </TabsContent>

                    <TabsContent value="servers" className="m-0 space-y-2.5">
                      {servers.length > 0 ? servers.map(server => (
                        <div key={server.pid} className="flex items-center gap-2 rounded-xl border border-white/6 bg-white/[0.03] p-2">
                          <div className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs font-semibold">Antigravity hub</div>
                            <div className="truncate text-[10px] text-muted-foreground">
                              pid {server.pid} · port {server.port}{server.ideVersion ? ` · v${server.ideVersion}` : ''}
                            </div>
                          </div>
                        </div>
                      )) : <div className="py-8 text-center text-[11px] text-muted-foreground">No hub running</div>}
                    </TabsContent>
                  </ScrollArea>
                </div>
              </Tabs>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </aside>
    </>
  );
}
