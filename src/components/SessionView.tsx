import { Bot, User, Gauge, Zap, Layers, Terminal, FileText, Search, PenLine, Brain, MessageSquare, ChevronDown, ChevronRight, Coins } from "lucide-react";
import { clsx } from "clsx";
import { useState } from "react";
import type { SessionDetail, Action } from "../App";

interface Props {
  session: SessionDetail;
}

function ActionIcon({ type }: { type: string }) {
  switch (type) {
    case "reasoning": return <Brain size={12} className="text-purple-400" />;
    case "say": return <MessageSquare size={12} className="text-blue-400" />;
    case "runCommand": return <Terminal size={12} className="text-green-400" />;
    case "readFiles": return <FileText size={12} className="text-yellow-400" />;
    case "search": return <Search size={12} className="text-cyan-400" />;
    case "replace": case "write": case "create": return <PenLine size={12} className="text-orange-400" />;
    default: return <Zap size={12} className="text-[var(--text-secondary)]" />;
  }
}

function ActionLabel({ action }: { action: Action }) {
  const { actionType, input } = action;
  switch (actionType) {
    case "runCommand": return <>{input?.command || "command"}</>;
    case "readFiles": return <>{input?.files?.map((f: any) => f.path).join(", ") || "read"}</>;
    case "search": return <>{input?.query || "search"}</>;
    case "replace": case "write": case "create": return <>{input?.file || actionType}</>;
    case "getDiagnostics": return <>{input?.paths?.join(", ") || "diagnostics"}</>;
    default: return <>{actionType}</>;
  }
}

function ActionBlock({ action }: { action: Action }) {
  const [expanded, setExpanded] = useState(false);
  const isThinking = action.actionType === "reasoning";
  const isSay = action.actionType === "say";
  const message = action.output?.message || "";

  if (isSay) {
    return (
      <div className="text-sm text-[var(--text-primary)] whitespace-pre-wrap">
        {message}
      </div>
    );
  }

  if (isThinking) {
    return (
      <div className="border-l-2 border-purple-500/40 pl-3 my-1">
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Brain size={12} /> Thinking
        </button>
        {expanded && (
          <div className="mt-1 text-xs text-[var(--text-secondary)] whitespace-pre-wrap">{message}</div>
        )}
      </div>
    );
  }

  return (
    <div className="my-1">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-mono">
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ActionIcon type={action.actionType} />
        <span className="truncate max-w-md"><ActionLabel action={action} /></span>
        {action.actionState && action.actionState !== "Success" && (
          <span className="text-yellow-500 ml-1">({action.actionState})</span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-5 text-xs bg-[var(--bg-tertiary)] rounded p-2 overflow-x-auto">
          {action.input && <pre className="text-[var(--text-secondary)]">{JSON.stringify(action.input, null, 2)}</pre>}
          {action.output && (
            <pre className="mt-1 text-[var(--text-primary)] border-t border-[var(--border)] pt-1">
              {typeof action.output === "object" ? JSON.stringify(action.output, null, 2) : String(action.output)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function SessionView({ session }: Props) {
  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-6">
        <h2 className="text-lg font-medium mb-2">{session.title || "Untitled"}</h2>
        <div className="flex flex-wrap gap-3 text-xs text-[var(--text-secondary)]">
          <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--bg-tertiary)]">
            <Bot size={12} /> {session.model}
          </span>
          <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--bg-tertiary)]">
            <Zap size={12} /> {session.autonomyMode}
          </span>
          <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--bg-tertiary)]">
            <Layers size={12} /> {session.sessionType}
          </span>
          <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--bg-tertiary)]">
            <Gauge size={12} /> {session.contextUsage?.toFixed(1)}% context
          </span>
          <span className="px-2 py-1 rounded-full bg-[var(--bg-tertiary)]">
            {session.messageCount} messages
          </span>
          {session.totalCost > 0 && (
            <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-[var(--bg-tertiary)]">
              <Coins size={12} /> {session.totalCost.toFixed(2)} credits
            </span>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {session.history.map((msg, i) => (
          <div
            key={i}
            className={clsx(
              "rounded-lg p-4 text-sm leading-relaxed",
              msg.role === "user"
                ? "bg-[var(--bg-tertiary)] border border-[var(--border)]"
                : "bg-[var(--bg-secondary)] border border-[var(--border)]"
            )}
          >
            <div className="flex items-center gap-2 mb-2 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">
              {msg.role === "user" ? (
                <User size={12} className="text-blue-400" />
              ) : (
                <Bot size={12} className="text-[var(--accent)]" />
              )}
              {msg.role}
              {msg.cost ? (
                <span className="ml-auto font-normal normal-case tracking-normal text-[var(--text-secondary)]">
                  {msg.cost.toFixed(2)} credits
                </span>
              ) : null}
            </div>

            {msg.content && (
              <div className="whitespace-pre-wrap break-words text-[var(--text-primary)]">
                {msg.content}
              </div>
            )}

            {msg.actions && msg.actions.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {msg.actions.map((action, j) => (
                  <ActionBlock key={j} action={action} />
                ))}
              </div>
            )}

            {!msg.content && (!msg.actions || msg.actions.length === 0) && (
              <span className="italic text-[var(--text-secondary)]">(empty)</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
