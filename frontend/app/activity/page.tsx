'use client';

import { useState, useEffect } from 'react';

// Disable static generation for this page (requires authentication)
export const dynamic = 'force-dynamic';

import { activity, auth } from '@/lib/api';
import {
  Clock,
  CheckCircle,
  XCircle,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  Loader2,
  TrendingUp,
  Activity as ActivityIcon,
  Zap,
  Calendar as CalendarIcon
} from 'lucide-react';

interface SessionActivity {
  sessionId: string;
  startTime: Date;
  endTime: Date | null;
  duration: number;
  commandCount: number;
  successCount: number;
  mode: string;
  status: string;
  commands: CommandActivity[];
}

interface CommandActivity {
  id: string;
  timestamp: Date;
  query: string;
  response: string;
  toolCalls: Array<{
    tool: string;
    params: Record<string, unknown>;
    result: unknown;
    success: boolean;
  }>;
  success: boolean;
  duration?: number;
}

interface ActivityStats {
  totalSessions: number;
  totalCommands: number;
  successfulCommands: number;
  successRate: string;
  connectedServices: number;
  period: string;
}

export default function ActivityPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionActivity[]>([]);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [expandedCommands, setExpandedCommands] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const isAuthenticated = await auth.isAuthenticated();
      if (!isAuthenticated) {
        window.location.href = '/login';
        return;
      }

      // Load activity data
      const activityResponse = await activity.getHistory({ limit: 50 });

      // Load stats
      const statsResponse = await activity.getStats();

      // Group activities into sessions
      const sessionMap = new Map<string, SessionActivity>();

      for (const item of activityResponse.activities) {
        // Skip oauth events for now - focus on sessions
        if (item.type === 'oauth_connect' || item.type === 'oauth_disconnect') {
          continue;
        }

        if (item.type === 'session') {
          const sessionId = item.id.replace('-end', '');

          if (!sessionMap.has(sessionId)) {
            // New session
            sessionMap.set(sessionId, {
              sessionId,
              startTime: new Date(item.timestamp),
              endTime: null,
              duration: 0,
              commandCount: (item.details?.commandCount as number) || 0,
              successCount: (item.details?.successCount as number) || 0,
              mode: (item.details?.mode as string) || 'continuous',
              status: (item.details?.status as string) || 'active',
              commands: []
            });
          } else {
            // Session end
            const session = sessionMap.get(sessionId)!;
            session.endTime = new Date(item.timestamp);
            session.duration = (item.details?.duration as number) || 0;
          }
        } else if (item.type === 'command') {
          // Extract session ID from command details if available
          // For now, create a synthetic session for commands without session
          const sessionId = 'unknown';

          if (!sessionMap.has(sessionId)) {
            sessionMap.set(sessionId, {
              sessionId,
              startTime: new Date(item.timestamp),
              endTime: null,
              duration: 0,
              commandCount: 0,
              successCount: 0,
              mode: 'unknown',
              status: 'unknown',
              commands: []
            });
          }

          const session = sessionMap.get(sessionId)!;

          // Parse tool results
          const toolCalls = [];
          if (item.details?.mcpTool) {
            toolCalls.push({
              tool: item.details.mcpTool as string,
              params: (item.details.mcpParams as Record<string, unknown>) || {},
              result: item.details.mcpResult || null,
              success: item.success ?? true
            });
          }

          session.commands.push({
            id: item.id,
            timestamp: new Date(item.timestamp),
            query: item.title,
            response: item.description,
            toolCalls,
            success: item.success ?? true,
            duration: (item.details?.latency as number) || (item.details?.durationMs as number)
          });

          session.commandCount++;
          if (item.success) session.successCount++;
        }
      }

      // Convert to array and sort by start time
      const sessionsArray = Array.from(sessionMap.values())
        .filter(s => s.sessionId !== 'unknown') // Filter out synthetic sessions
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

      setSessions(sessionsArray);
      setStats(statsResponse.stats);
      setIsLoading(false);

    } catch (err) {
      console.error('Failed to load activity:', err);
      setError(err instanceof Error ? err.message : 'Failed to load data');
      setIsLoading(false);
    }
  };

  const toggleSession = (sessionId: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const toggleCommand = (commandId: string) => {
    setExpandedCommands(prev => {
      const next = new Set(prev);
      if (next.has(commandId)) {
        next.delete(commandId);
      } else {
        next.add(commandId);
      }
      return next;
    });
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  const formatTime = (date: Date) => {
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Loading activity...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-center justify-center">
        <div className="bg-white p-8 rounded-xl shadow-lg max-w-md">
          <XCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-gray-900 mb-2 text-center">Failed to Load Activity</h2>
          <p className="text-gray-600 text-center mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-indigo-600 text-white py-2 px-4 rounded-lg hover:bg-indigo-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
                <ActivityIcon className="w-8 h-8 text-indigo-600" />
                Activity History
              </h1>
              <p className="text-gray-600 mt-1">Your voice command sessions</p>
            </div>
            <button
              onClick={() => window.location.href = '/dashboard'}
              className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-200 transition-colors text-sm"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
              <div className="flex items-center gap-2 mb-1">
                <CalendarIcon className="w-4 h-4 text-blue-600" />
                <p className="text-xs text-gray-600">Sessions</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.totalSessions}</p>
            </div>

            <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
              <div className="flex items-center gap-2 mb-1">
                <MessageSquare className="w-4 h-4 text-purple-600" />
                <p className="text-xs text-gray-600">Commands</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.totalCommands}</p>
            </div>

            <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-green-600" />
                <p className="text-xs text-gray-600">Success Rate</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.successRate}</p>
            </div>

            <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
              <div className="flex items-center gap-2 mb-1">
                <Zap className="w-4 h-4 text-indigo-600" />
                <p className="text-xs text-gray-600">Services</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.connectedServices}</p>
            </div>
          </div>
        )}

        {/* Privacy Notice */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-6">
          <div className="flex items-start gap-2">
            <ActivityIcon className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-xs text-blue-900 font-medium">Privacy & Security</p>
              <p className="text-xs text-blue-800 mt-0.5">
                All tokens are encrypted (AES-256) and only used for your explicit commands. No third-party sharing.
              </p>
            </div>
          </div>
        </div>

        {/* Sessions List */}
        <div className="space-y-3">
          {sessions.length === 0 ? (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
              <ActivityIcon className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-600 font-medium">No sessions yet</p>
              <p className="text-sm text-gray-500 mt-1">Start using voice commands to see your activity</p>
            </div>
          ) : (
            sessions.map((session) => {
              const isExpanded = expandedSessions.has(session.sessionId);
              const successRate = session.commandCount > 0
                ? Math.round((session.successCount / session.commandCount) * 100)
                : 0;

              return (
                <div
                  key={session.sessionId}
                  className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden hover:shadow-md transition-shadow"
                >
                  {/* Session Header - Clickable */}
                  <button
                    onClick={() => toggleSession(session.sessionId)}
                    className="w-full p-4 flex items-center justify-between hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="flex items-center gap-4 flex-1">
                      {/* Status Icon */}
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                        session.status === 'completed' ? 'bg-green-100' : 'bg-blue-100'
                      }`}>
                        {session.status === 'completed' ? (
                          <CheckCircle className="w-5 h-5 text-green-600" />
                        ) : (
                          <Clock className="w-5 h-5 text-blue-600" />
                        )}
                      </div>

                      {/* Session Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="font-semibold text-gray-900 text-sm">
                            {formatTime(session.startTime)}
                          </p>
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                            {session.mode}
                          </span>
                        </div>
                        <div className="flex items-center gap-4 text-xs text-gray-600">
                          <span className="flex items-center gap-1">
                            <MessageSquare className="w-3 h-3" />
                            {session.commandCount} commands
                          </span>
                          <span className="flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" />
                            {successRate}% success
                          </span>
                          {session.duration > 0 && (
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatDuration(session.duration)}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Expand Icon */}
                      {isExpanded ? (
                        <ChevronUp className="w-5 h-5 text-gray-400" />
                      ) : (
                        <ChevronDown className="w-5 h-5 text-gray-400" />
                      )}
                    </div>
                  </button>

                  {/* Session Details - Expandable */}
                  {isExpanded && (
                    <div className="border-t border-gray-200 bg-gray-50">
                      {session.commands.length === 0 ? (
                        <div className="p-4 text-center text-sm text-gray-500">
                          No commands recorded
                        </div>
                      ) : (
                        <div className="p-3 space-y-2">
                          {session.commands.map((cmd) => {
                            const isCmdExpanded = expandedCommands.has(cmd.id);

                            return (
                              <div
                                key={cmd.id}
                                className="bg-white rounded-lg border border-gray-200 overflow-hidden"
                              >
                                {/* Command Header */}
                                <button
                                  onClick={() => toggleCommand(cmd.id)}
                                  className="w-full p-3 flex items-start gap-3 hover:bg-gray-50 transition-colors text-left"
                                >
                                  <div className={`w-6 h-6 rounded flex items-center justify-center flex-shrink-0 mt-0.5 ${
                                    cmd.success ? 'bg-green-100' : 'bg-red-100'
                                  }`}>
                                    {cmd.success ? (
                                      <CheckCircle className="w-4 h-4 text-green-600" />
                                    ) : (
                                      <XCircle className="w-4 h-4 text-red-600" />
                                    )}
                                  </div>

                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-gray-900 mb-0.5">
                                      {cmd.query}
                                    </p>
                                    <p className="text-xs text-gray-600 line-clamp-1">
                                      {cmd.response}
                                    </p>
                                    <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                                      <span>{formatTime(cmd.timestamp)}</span>
                                      {cmd.duration && (
                                        <>
                                          <span>•</span>
                                          <span>{formatDuration(cmd.duration)}</span>
                                        </>
                                      )}
                                      {cmd.toolCalls.length > 0 && (
                                        <>
                                          <span>•</span>
                                          <span>{cmd.toolCalls.length} tool{cmd.toolCalls.length > 1 ? 's' : ''}</span>
                                        </>
                                      )}
                                    </div>
                                  </div>

                                  {cmd.toolCalls.length > 0 && (
                                    isCmdExpanded ? (
                                      <ChevronUp className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                    ) : (
                                      <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                                    )
                                  )}
                                </button>

                                {/* Command Details - Tool Calls */}
                                {isCmdExpanded && cmd.toolCalls.length > 0 && (
                                  <div className="border-t border-gray-200 bg-gray-50 p-3 space-y-2">
                                    {cmd.toolCalls.map((tool, idx) => (
                                      <div
                                        key={idx}
                                        className="bg-white rounded border border-gray-200 p-2"
                                      >
                                        <div className="flex items-center gap-2 mb-2">
                                          <Zap className="w-3 h-3 text-indigo-600" />
                                          <span className="text-xs font-medium text-gray-900">
                                            {tool.tool}
                                          </span>
                                          {tool.success ? (
                                            <CheckCircle className="w-3 h-3 text-green-600" />
                                          ) : (
                                            <XCircle className="w-3 h-3 text-red-600" />
                                          )}
                                        </div>

                                        {/* Tool Params */}
                                        {Object.keys(tool.params).length > 0 && (
                                          <details className="mt-2">
                                            <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-900">
                                              Parameters
                                            </summary>
                                            <pre className="mt-1 text-xs bg-gray-50 p-2 rounded border border-gray-200 overflow-x-auto">
                                              {JSON.stringify(tool.params, null, 2)}
                                            </pre>
                                          </details>
                                        )}

                                        {/* Tool Result */}
                                        {tool.result && (
                                          <details className="mt-2">
                                            <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-900">
                                              Result
                                            </summary>
                                            <pre className="mt-1 text-xs bg-gray-50 p-2 rounded border border-gray-200 overflow-x-auto">
                                              {JSON.stringify(tool.result, null, 2)}
                                            </pre>
                                          </details>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
