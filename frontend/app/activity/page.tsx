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
  Calendar as CalendarIcon,
  Link as LinkIcon,
  UnlinkIcon,
  ChevronLeft,
  ChevronRight,
  Loader2,
  TrendingUp,
  Activity as ActivityIcon
} from 'lucide-react';

interface ActivityItem {
  id: string;
  timestamp: Date;
  type: 'session' | 'command' | 'oauth_connect' | 'oauth_disconnect';
  title: string;
  description: string;
  details?: Record<string, unknown>;
  success?: boolean;
  service?: string;
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
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkAuthAndLoadData();
  }, [page]);

  const checkAuthAndLoadData = async () => {
    try {
      const isAuthenticated = await auth.isAuthenticated();
      if (!isAuthenticated) {
        window.location.href = '/login';
        return;
      }

      await Promise.all([
        loadActivities(),
        loadStats()
      ]);

    } catch (err) {
      console.error('Failed to load activity data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  };

  const loadActivities = async () => {
    try {
      const response = await activity.getHistory({ page, limit: 20 });

      // Parse timestamps
      const parsedActivities = response.activities.map(item => ({
        ...item,
        timestamp: new Date(item.timestamp)
      }));

      setActivities(parsedActivities);
      setTotalPages(response.pagination.totalPages);
      setHasMore(response.pagination.hasMore);
    } catch (err) {
      console.error('Failed to load activities:', err);
      throw err;
    }
  };

  const loadStats = async () => {
    try {
      const response = await activity.getStats();
      setStats(response.stats);
    } catch (err) {
      console.error('Failed to load stats:', err);
      // Don't throw - stats are optional
    }
  };

  const handlePreviousPage = () => {
    if (page > 1) {
      setPage(page - 1);
    }
  };

  const handleNextPage = () => {
    if (hasMore) {
      setPage(page + 1);
    }
  };

  const getActivityIcon = (type: ActivityItem['type']) => {
    switch (type) {
      case 'session':
        return <Clock className="w-5 h-5" />;
      case 'command':
        return <MessageSquare className="w-5 h-5" />;
      case 'oauth_connect':
        return <LinkIcon className="w-5 h-5" />;
      case 'oauth_disconnect':
        return <UnlinkIcon className="w-5 h-5" />;
      default:
        return <ActivityIcon className="w-5 h-5" />;
    }
  };

  const getActivityColor = (type: ActivityItem['type'], success?: boolean) => {
    if (success === false) return 'text-red-600 bg-red-50 border-red-200';

    switch (type) {
      case 'session':
        return 'text-blue-600 bg-blue-50 border-blue-200';
      case 'command':
        return 'text-purple-600 bg-purple-50 border-purple-200';
      case 'oauth_connect':
        return 'text-green-600 bg-green-50 border-green-200';
      case 'oauth_disconnect':
        return 'text-orange-600 bg-orange-50 border-orange-200';
      default:
        return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  };

  const formatTimestamp = (timestamp: Date) => {
    const now = new Date();
    const diff = now.getTime() - timestamp.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
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
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
                <ActivityIcon className="w-8 h-8 text-indigo-600" />
                Activity History
              </h1>
              <p className="text-gray-600 mt-1">Transparent log of all your interactions and commands</p>
            </div>
            <button
              onClick={() => window.location.href = '/dashboard'}
              className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Cards */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8">
            <div className="bg-white p-6 rounded-xl shadow-md border border-gray-200">
              <div className="flex items-center gap-3 mb-2">
                <CalendarIcon className="w-5 h-5 text-blue-600" />
                <p className="text-sm text-gray-600">Sessions</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.totalSessions}</p>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-md border border-gray-200">
              <div className="flex items-center gap-3 mb-2">
                <MessageSquare className="w-5 h-5 text-purple-600" />
                <p className="text-sm text-gray-600">Commands</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.totalCommands}</p>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-md border border-gray-200">
              <div className="flex items-center gap-3 mb-2">
                <CheckCircle className="w-5 h-5 text-green-600" />
                <p className="text-sm text-gray-600">Successful</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.successfulCommands}</p>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-md border border-gray-200">
              <div className="flex items-center gap-3 mb-2">
                <TrendingUp className="w-5 h-5 text-indigo-600" />
                <p className="text-sm text-gray-600">Success Rate</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.successRate}</p>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-md border border-gray-200">
              <div className="flex items-center gap-3 mb-2">
                <LinkIcon className="w-5 h-5 text-green-600" />
                <p className="text-sm text-gray-600">Services</p>
              </div>
              <p className="text-2xl font-bold text-gray-900">{stats.connectedServices}</p>
            </div>
          </div>
        )}

        {/* Privacy Disclaimer */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <div className="flex items-start gap-3">
            <ActivityIcon className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm text-blue-900 font-medium mb-1">Your Privacy & Security</p>
              <p className="text-xs text-blue-800">
                All OAuth tokens are encrypted with AES-256 and only used for commands you explicitly request.
                Your credentials are never shared with third parties. This activity log provides full transparency
                into how Voice Commander interacts with your connected services.
              </p>
            </div>
          </div>
        </div>

        {/* Activity Timeline */}
        <div className="bg-white rounded-xl shadow-md border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-xl font-bold text-gray-900">Recent Activity</h2>
            <p className="text-sm text-gray-600 mt-1">{stats?.period || 'All time'}</p>
          </div>

          {activities.length === 0 ? (
            <div className="p-12 text-center">
              <ActivityIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-600 font-medium">No activity yet</p>
              <p className="text-sm text-gray-500 mt-1">Start using voice commands to see your activity here</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-200">
              {activities.map((item) => (
                <div key={item.id} className="p-6 hover:bg-gray-50 transition-colors">
                  <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className={`p-3 rounded-lg border ${getActivityColor(item.type, item.success)}`}>
                      {getActivityIcon(item.type)}
                    </div>

                    {/* Content */}
                    <div className="flex-1">
                      <div className="flex items-start justify-between mb-1">
                        <h3 className="text-base font-semibold text-gray-900">{item.title}</h3>
                        <div className="flex items-center gap-2">
                          {item.service && (
                            <span className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full">
                              {item.service}
                            </span>
                          )}
                          {item.success !== undefined && (
                            item.success ? (
                              <CheckCircle className="w-4 h-4 text-green-600" />
                            ) : (
                              <XCircle className="w-4 h-4 text-red-600" />
                            )
                          )}
                        </div>
                      </div>

                      <p className="text-sm text-gray-600 mb-2">{item.description}</p>

                      {/* Details */}
                      {item.details && Object.keys(item.details).length > 0 && (
                        <details className="text-xs text-gray-500 mt-2">
                          <summary className="cursor-pointer hover:text-gray-700">View details</summary>
                          <pre className="mt-2 p-3 bg-gray-50 rounded border border-gray-200 overflow-x-auto">
                            {JSON.stringify(item.details, null, 2)}
                          </pre>
                        </details>
                      )}

                      {/* Timestamp */}
                      <div className="flex items-center gap-2 mt-3 text-xs text-gray-500">
                        <Clock className="w-3 h-3" />
                        <span>{formatTimestamp(item.timestamp)}</span>
                        <span>•</span>
                        <span>{item.timestamp.toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="p-6 border-t border-gray-200 flex items-center justify-between">
              <button
                onClick={handlePreviousPage}
                disabled={page === 1}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </button>

              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>

              <button
                onClick={handleNextPage}
                disabled={!hasMore}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
