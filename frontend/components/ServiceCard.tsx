'use client';

import { Calendar, MessageSquare, FileText, Github, CheckCircle, XCircle, Loader2, RefreshCw, AlertCircle, Clock } from 'lucide-react';
import { useState, useEffect } from 'react';
import { oauth } from '@/lib/api';

interface ServiceCardProps {
  service: {
    id: string;
    name: string;
    description: string;
    icon: 'calendar' | 'slack' | 'notion' | 'github';
    connected: boolean;
    color: string;
    mcpConnected?: boolean;
    mcpStatus?: string;
    mcpToolsCount?: number;
    mcpError?: string | null;
  };
  onConnect?: (serviceId: string) => void;
  onDisconnect?: (serviceId: string) => void;
  onRefresh?: (serviceId: string) => void;
}

const iconMap = {
  calendar: Calendar,
  slack: MessageSquare,
  notion: FileText,
  github: Github,
};

// Map frontend service IDs to backend provider names
const serviceToProviderMap: Record<string, string> = {
  'google_calendar': 'google',
  'slack': 'slack',
  'notion': 'notion',
  'github': 'github',
};

// Parse error messages into user-friendly format
function parseErrorMessage(error: string | null): {
  type: 'transient' | 'auth_expired' | 'unknown' | null;
  title: string;
  message: string;
  action?: string;
} | null {
  if (!error) return null;

  if (error.includes('API has not been used') || error.includes('disabled')) {
    return {
      type: 'transient',
      title: 'Setup in progress',
      message: 'Google Calendar API is activating (2-3 minutes)',
      action: 'This page will auto-refresh when ready'
    };
  }

  if (error.includes('invalid_grant') || error.includes('expired')) {
    return {
      type: 'auth_expired',
      title: 'Authorization expired',
      message: 'Please reconnect your Google account',
      action: 'Click Disconnect, then Connect again'
    };
  }

  if (error.includes('Session not found')) {
    return {
      type: 'transient',
      title: 'Reconnecting...',
      message: 'MCP session is being restored',
      action: 'This will resolve automatically'
    };
  }

  return {
    type: 'unknown',
    title: 'Connection issue',
    message: error.length > 100 ? 'Something went wrong' : error,
    action: 'Try refreshing the connection'
  };
}

export default function ServiceCard({ service, onConnect, onDisconnect, onRefresh }: ServiceCardProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = iconMap[service.icon];

  const parsedError = parseErrorMessage(service.mcpError || null);

  const handleConnect = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const provider = serviceToProviderMap[service.id] || service.id;

      if (service.connected) {
        // Disconnect service
        await oauth.disconnect(provider);
        onDisconnect?.(service.id);
      } else {
        // Connect service - redirect to OAuth flow
        await oauth.connect(provider);
        // Note: User will be redirected to OAuth provider, then back to dashboard
        // onConnect will be called after successful OAuth callback
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Operation failed';
      setError(errorMessage);
      console.error('Service connection error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh?.(service.id);
    } finally {
      // Delay to show feedback
      setTimeout(() => setIsRefreshing(false), 500);
    }
  };

  // Auto-refresh for transient errors (every 30 seconds)
  useEffect(() => {
    if (parsedError?.type === 'transient' && onRefresh) {
      const interval = setInterval(() => {
        handleRefresh();
      }, 30000); // 30 seconds

      return () => clearInterval(interval);
    }
  }, [parsedError?.type, onRefresh]);

  return (
    <div className="bg-white rounded-xl shadow-md hover:shadow-lg transition-all border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className={`${service.color} p-6`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Icon className="w-12 h-12 text-white" />
            {service.connected && onRefresh && (
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="p-2 rounded-lg bg-white/20 hover:bg-white/30 transition-colors disabled:opacity-50"
                title="Refresh connection status"
              >
                <RefreshCw className={`w-4 h-4 text-white ${isRefreshing ? 'animate-spin' : ''}`} />
              </button>
            )}
          </div>
          {service.connected ? (
            <CheckCircle className="w-6 h-6 text-white" />
          ) : (
            <XCircle className="w-6 h-6 text-white/50" />
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-6">
        <h3 className="text-xl font-bold text-gray-900 mb-2">{service.name}</h3>
        <p className="text-gray-600 text-sm mb-4">{service.description}</p>

        {/* Dual Connection Status (OAuth + MCP) */}
        <div className="space-y-3 mb-4">
          {/* OAuth Status */}
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                service.connected ? 'bg-green-500' : 'bg-gray-300'
              }`}
            ></div>
            <span
              className={`text-sm font-medium ${
                service.connected ? 'text-green-600' : 'text-gray-500'
              }`}
            >
              OAuth: {service.connected ? 'Authorized' : 'Not authorized'}
            </span>
          </div>

          {/* MCP Status */}
          {service.connected && (
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  service.mcpConnected
                    ? 'bg-green-500'
                    : service.mcpStatus === 'connecting'
                    ? 'bg-yellow-500 animate-pulse'
                    : 'bg-gray-300'
                }`}
              ></div>
              <span
                className={`text-sm font-medium ${
                  service.mcpConnected
                    ? 'text-green-600'
                    : service.mcpStatus === 'connecting'
                    ? 'text-yellow-600'
                    : 'text-gray-500'
                }`}
              >
                MCP: {service.mcpConnected
                  ? `Connected (${service.mcpToolsCount || 0} tools)`
                  : service.mcpStatus === 'connecting'
                  ? 'Connecting...'
                  : service.mcpStatus === 'error'
                  ? 'Connection failed'
                  : 'Not connected'}
              </span>
            </div>
          )}

          {/* MCP Error Display - User Friendly */}
          {parsedError && (
            <div className={`mt-2 p-3 rounded-lg border ${
              parsedError.type === 'transient'
                ? 'bg-blue-50 border-blue-200'
                : parsedError.type === 'auth_expired'
                ? 'bg-orange-50 border-orange-200'
                : 'bg-yellow-50 border-yellow-200'
            }`}>
              <div className="flex items-start gap-2">
                {parsedError.type === 'transient' ? (
                  <Clock className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-orange-600 mt-0.5 flex-shrink-0" />
                )}
                <div className="flex-1">
                  <p className={`text-xs font-semibold mb-1 ${
                    parsedError.type === 'transient'
                      ? 'text-blue-800'
                      : 'text-orange-800'
                  }`}>
                    {parsedError.title}
                  </p>
                  <p className={`text-xs ${
                    parsedError.type === 'transient'
                      ? 'text-blue-700'
                      : 'text-orange-700'
                  }`}>
                    {parsedError.message}
                  </p>
                  {parsedError.action && (
                    <p className={`text-xs mt-1 italic ${
                      parsedError.type === 'transient'
                        ? 'text-blue-600'
                        : 'text-orange-600'
                    }`}>
                      → {parsedError.action}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* Connect/Disconnect Button */}
        <button
          onClick={handleConnect}
          disabled={isLoading}
          className={`
            w-full py-3 px-4 rounded-lg font-semibold transition-all
            ${
              service.connected
                ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                : 'bg-indigo-600 text-white hover:bg-indigo-700 hover:scale-105'
            }
            ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}
            focus:outline-none focus:ring-2 focus:ring-indigo-300
          `}
        >
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              {service.connected ? 'Disconnecting...' : 'Connecting...'}
            </span>
          ) : service.connected ? (
            'Disconnect'
          ) : (
            'Connect'
          )}
        </button>
      </div>
    </div>
  );
}
