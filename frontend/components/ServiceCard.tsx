'use client';

import { Calendar, MessageSquare, FileText, Github, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useState } from 'react';
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

export default function ServiceCard({ service, onConnect, onDisconnect }: ServiceCardProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = iconMap[service.icon];

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

  return (
    <div className="bg-white rounded-xl shadow-md hover:shadow-lg transition-all border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className={`${service.color} p-6`}>
        <div className="flex items-center justify-between">
          <Icon className="w-12 h-12 text-white" />
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

          {/* MCP Error Display */}
          {service.mcpError && (
            <div className="mt-2 p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-700">
              ⚠️ {service.mcpError}
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
