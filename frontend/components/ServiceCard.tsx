'use client';

import { Calendar, MessageSquare, FileText, Github, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useState } from 'react';

interface ServiceCardProps {
  service: {
    id: string;
    name: string;
    description: string;
    icon: 'calendar' | 'slack' | 'notion' | 'github';
    connected: boolean;
    color: string;
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

export default function ServiceCard({ service, onConnect, onDisconnect }: ServiceCardProps) {
  const [isLoading, setIsLoading] = useState(false);
  const Icon = iconMap[service.icon];

  const handleConnect = async () => {
    setIsLoading(true);
    try {
      // TODO: Replace with actual OAuth flow
      // For now, simulate API call
      await new Promise(resolve => setTimeout(resolve, 1500));

      if (service.connected) {
        onDisconnect?.(service.id);
      } else {
        // Redirect to OAuth flow
        // window.location.href = `/auth/${service.id}?userId=current-user-id`;
        onConnect?.(service.id);
      }
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

        {/* Connection Status */}
        <div className="flex items-center gap-2 mb-4">
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
            {service.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>

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
