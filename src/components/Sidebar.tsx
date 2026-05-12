import { useState } from "react";
import { ChevronRight, FolderOpen, MessageSquare, LayoutDashboard, List } from "lucide-react";
import { clsx } from "clsx";
import type { Workspace } from "../App";

interface Props {
  workspaces: Workspace[];
  selectedSession: { workspaceId: string; sessionId: string } | null;
  onSelect: (workspaceId: string, sessionId: string) => void;
  view: "dashboard" | "sessions";
  onViewChange: (view: "dashboard" | "sessions") => void;
}

export function Sidebar({ workspaces, selectedSession, onSelect, view, onViewChange }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <aside className="w-80 h-full border-r border-[var(--border)] bg-[var(--bg-secondary)] flex flex-col">
      <div className="p-4 border-b border-[var(--border)]">
        <h1 className="text-sm font-semibold tracking-wide uppercase text-[var(--accent)]">
          Sessions Inspector
        </h1>
        <p className="text-xs text-[var(--text-secondary)] mt-1">
          {workspaces.length} workspaces •{" "}
          {workspaces.reduce((a, w) => a + w.sessionCount, 0)} sessions
        </p>
      </div>
      <div className="flex border-b border-[var(--border)]">
        <button
          onClick={() => onViewChange("dashboard")}
          className={clsx("flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors", view === "dashboard" ? "text-[var(--accent)] border-b-2 border-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]")}
        >
          <LayoutDashboard size={12} /> Dashboard
        </button>
        <button
          onClick={() => onViewChange("sessions")}
          className={clsx("flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors", view === "sessions" ? "text-[var(--accent)] border-b-2 border-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]")}
        >
          <List size={12} /> Sessions
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {workspaces.map((ws) => (
          <div key={ws.id}>
            <button
              onClick={() => toggle(ws.id)}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[var(--bg-tertiary)] text-left text-sm transition-colors"
            >
              <ChevronRight
                size={14}
                className={clsx(
                  "text-[var(--text-secondary)] transition-transform shrink-0",
                  expanded.has(ws.id) && "rotate-90"
                )}
              />
              <FolderOpen size={14} className="text-[var(--accent)] shrink-0" />
              <span className="truncate flex-1">{ws.name}</span>
              <span className="text-xs text-[var(--text-secondary)] tabular-nums">
                {ws.sessionCount}
              </span>
            </button>
            {expanded.has(ws.id) && (
              <div className="ml-5 pl-2 border-l border-[var(--border)] space-y-0.5 mt-0.5">
                {ws.sessions
                  .sort((a, b) => b.date - a.date)
                  .map((s) => (
                    <button
                      key={s.id}
                      onClick={() => onSelect(ws.id, s.id)}
                      className={clsx(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs transition-colors",
                        selectedSession?.sessionId === s.id
                          ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                          : "hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                      )}
                    >
                      <MessageSquare size={12} className="shrink-0" />
                      <span className="truncate">
                        {s.title || "Untitled session"}
                      </span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
