'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { SendHorizontal, Square, ChevronDown, Puzzle, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ModelConfig, Skill, Workflow } from '@/lib/types';

interface ChatInputProps {
  onSend: (text: string) => void;
  onCancel?: () => void;
  disabled?: boolean;
  isRunning?: boolean;
  connected?: boolean;
  models?: ModelConfig[];
  currentModel?: string;
  onModelChange?: (model: string) => void;
  skills?: Skill[];
  workflows?: Workflow[];
}

interface AutocompleteItem {
  type: 'skill' | 'workflow';
  name: string;
  description: string;
  prefix: string; // what gets inserted
}

export default function ChatInput({ onSend, onCancel, disabled, isRunning, connected, models, currentModel, onModelChange, skills, workflows }: ChatInputProps) {
  const [text, setText] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [menuItems, setMenuItems] = useState<AutocompleteItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [triggerChar, setTriggerChar] = useState<'/' | '@' | null>(null);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + 'px';
    }
  }, [text]);

  // Build autocomplete items
  const allItems = useMemo(() => {
    const items: AutocompleteItem[] = [];
    (workflows || []).forEach(w => {
      items.push({ type: 'workflow', name: w.name, description: w.description || '', prefix: `/${w.name} ` });
    });
    (skills || []).forEach(s => {
      items.push({ type: 'skill', name: s.name, description: s.description || '', prefix: `@${s.name} ` });
    });
    return items;
  }, [skills, workflows]);

  // Handle text changes — detect / and @ triggers
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);

    const cursorPos = e.target.selectionStart || 0;
    const textBeforeCursor = val.slice(0, cursorPos);

    // Check for / at start of line or after whitespace
    const slashMatch = textBeforeCursor.match(/(^|\s)\/([\w-]*)$/);
    // Check for @ at start of line or after whitespace
    const atMatch = textBeforeCursor.match(/(^|\s)@([\w-]*)$/);

    if (slashMatch) {
      const q = slashMatch[2].toLowerCase();
      setTriggerChar('/');
      setQuery(q);
      const filtered = allItems
        .filter(i => i.type === 'workflow' && i.name.toLowerCase().includes(q))
        .slice(0, 8);
      setMenuItems(filtered);
      setShowMenu(filtered.length > 0);
      setSelectedIdx(0);
    } else if (atMatch) {
      const q = atMatch[2].toLowerCase();
      setTriggerChar('@');
      setQuery(q);
      const filtered = allItems
        .filter(i => i.type === 'skill' && i.name.toLowerCase().includes(q))
        .slice(0, 8);
      setMenuItems(filtered);
      setShowMenu(filtered.length > 0);
      setSelectedIdx(0);
    } else {
      setShowMenu(false);
      setTriggerChar(null);
    }
  };

  // Insert selected autocomplete item
  const insertItem = useCallback((item: AutocompleteItem) => {
    const textarea = ref.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart || 0;
    const textBeforeCursor = text.slice(0, cursorPos);
    const textAfterCursor = text.slice(cursorPos);

    // Find the trigger position (/ or @)
    const triggerRegex = triggerChar === '/'
      ? /(^|\s)\/([\w-]*)$/
      : /(^|\s)@([\w-]*)$/;
    const match = textBeforeCursor.match(triggerRegex);

    if (match) {
      const triggerStart = match.index! + match[1].length;
      const newText = text.slice(0, triggerStart) + item.prefix + textAfterCursor;
      setText(newText);
      setShowMenu(false);
      setTriggerChar(null);

      // Set cursor after inserted text
      setTimeout(() => {
        const newPos = triggerStart + item.prefix.length;
        textarea.selectionStart = newPos;
        textarea.selectionEnd = newPos;
        textarea.focus();
      }, 0);
    }
  }, [text, triggerChar]);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    setShowMenu(false);
  }, [text, disabled, onSend]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (showMenu && menuItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(i => (i + 1) % menuItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(i => (i - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        insertItem(menuItems[selectedIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMenu(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Derive display label for the current model
  const currentLabel = models?.find(m => m.modelOrAlias?.model === currentModel)?.label || currentModel || 'Model';

  return (
    <div className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 p-4 border-t">
      <div className="max-w-4xl mx-auto flex flex-col gap-2 relative">
        {/* Autocomplete Menu */}
        {showMenu && menuItems.length > 0 && (
          <div
            ref={menuRef}
            className="absolute bottom-full mb-1 left-0 right-0 z-50 bg-popover border rounded-lg shadow-lg overflow-hidden max-h-[240px] overflow-y-auto"
          >
            {menuItems.map((item, idx) => (
              <button
                key={`${item.type}-${item.name}`}
                className={cn(
                  "w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors",
                  idx === selectedIdx ? "bg-accent" : "hover:bg-muted/50"
                )}
                onMouseDown={(e) => { e.preventDefault(); insertItem(item); }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                {item.type === 'workflow' ? (
                  <Zap className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" />
                ) : (
                  <Puzzle className="w-4 h-4 mt-0.5 text-indigo-500 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {item.type === 'workflow' ? '/' : '@'}{item.name}
                  </div>
                  {item.description && (
                    <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                      {item.description}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="relative flex items-end gap-2 bg-muted/50 rounded-lg border focus-within:ring-1 focus-within:ring-ring p-1 pl-3 transition-shadow">
          <Textarea
            ref={ref}
            value={text}
            onChange={handleChange}
            onKeyDown={handleKey}
            onBlur={() => setTimeout(() => setShowMenu(false), 150)}
            placeholder="Type a message... (/ for workflows, @ for skills)"
            className="min-h-[44px] max-h-[200px] w-full resize-none border-0 shadow-none focus-visible:ring-0 px-0 py-3 bg-transparent"
            disabled={disabled}
            rows={1}
          />
          <div className="p-1 mb-0.5 sticky bottom-1">
            {isRunning ? (
              <Button
                variant="destructive"
                size="icon"
                className="h-9 w-9"
                onClick={onCancel}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="h-9 w-9"
                onClick={send}
                disabled={disabled || !text.trim()}
              >
                <SendHorizontal className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        
        <div className="flex items-center gap-2 px-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium uppercase tracking-wider">
            <span className={cn(
              'w-2 h-2 rounded-full',
              connected ? 'bg-emerald-500' : 'bg-destructive'
            )} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>

          {/* Model selector — inline in the input area */}
          {models && models.length > 0 && onModelChange && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="ml-auto inline-flex items-center gap-1 h-7 px-2 text-xs text-muted-foreground hover:text-foreground font-medium rounded-md hover:bg-accent transition-colors cursor-pointer"
              >
                <span className="truncate max-w-[160px]">{currentLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {models.map(m => {
                  const val = m.modelOrAlias?.model || '';
                  const pct = m.quotaInfo?.remainingFraction != null
                    ? `${Math.round(m.quotaInfo.remainingFraction * 100)}%`
                    : '';
                  const isSelected = val === currentModel;
                  return (
                    <DropdownMenuItem
                      key={val}
                      onClick={() => onModelChange(val)}
                      className={cn('flex justify-between gap-2', isSelected && 'bg-accent')}
                    >
                      <span className="truncate">{m.label}</span>
                      {pct && (
                        <span className={cn(
                          'text-[10px] font-mono shrink-0',
                          parseFloat(pct) > 50 ? 'text-emerald-500' : parseFloat(pct) > 20 ? 'text-amber-500' : 'text-destructive'
                        )}>
                          {pct}
                        </span>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          
          {isRunning && (
            <div className={cn(
              "flex items-center gap-2 text-xs text-amber-500 font-medium bg-amber-500/10 px-2 py-1 rounded-md",
              models && models.length > 0 ? '' : 'ml-auto'
            )}>
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              Running
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
