'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Mic, Settings, ArrowLeft, Info, CheckCircle, XCircle, User, LogOut, ChevronDown } from 'lucide-react';
import VoiceInterface from '@/components/VoiceInterface';
import ServiceCard from '@/components/ServiceCard';
import { auth, oauth } from '@/lib/api';

// Map backend provider names to frontend service IDs
const providerToServiceMap: Record<string, string> = {
  'google': 'google_calendar',
  'slack': 'slack',
  'notion': 'notion',
  'github': 'github',
};

export default function DashboardPage() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<'voice' | 'services'>('voice');
  const [services, setServices] = useState([
    {
      id: 'google_calendar',
      name: 'Google Calendar',
      description: 'Schedule meetings and manage your calendar',
      icon: 'calendar' as const,
      connected: false,
      color: 'bg-blue-500',
    },
    {
      id: 'slack',
      name: 'Slack',
      description: 'Send messages and manage channels',
      icon: 'slack' as const,
      connected: false,
      color: 'bg-purple-500',
    },
    {
      id: 'notion',
      name: 'Notion',
      description: 'Create pages and manage documents',
      icon: 'notion' as const,
      connected: false,
      color: 'bg-gray-900',
    },
    {
      id: 'github',
      name: 'GitHub',
      description: 'Manage repositories and issues',
      icon: 'github' as const,
      connected: false,
      color: 'bg-gray-700',
    },
  ]);

  const [commandHistory, setCommandHistory] = useState<Array<{ command: string; result: any }>>([]);
  const [oauthNotification, setOauthNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [userEmail, setUserEmail] = useState<string>('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);

  // Check authentication and fetch OAuth connections on mount
  useEffect(() => {
    const initializeDashboard = async () => {
      // Check if user is authenticated
      if (!auth.isAuthenticated()) {
        window.location.href = '/login';
        return;
      }

      try {
        // Fetch user info
        const user = await auth.getCurrentUser();
        setUserEmail(user.email);

        // Fetch OAuth connections
        const connections = await oauth.getConnections();

        // Update services with connection status
        setServices(prev => prev.map(service => {
          const provider = service.id === 'google_calendar' ? 'google' : service.id;
          const connection = connections.find(c => c.provider === provider);
          return {
            ...service,
            connected: connection?.connected || false,
          };
        }));
      } catch (error) {
        console.error('Failed to initialize dashboard:', error);
        // If error is 401/403, user will be redirected to login by API client
      }
    };

    initializeDashboard();
  }, []);

  // Handle OAuth callback
  useEffect(() => {
    const success = searchParams.get('success');
    const error = searchParams.get('error');
    const provider = searchParams.get('provider');

    if (success === 'true' && provider) {
      // OAuth connection successful
      const serviceId = providerToServiceMap[provider] || provider;

      setServices(prev => prev.map(s =>
        s.id === serviceId ? { ...s, connected: true } : s
      ));

      setOauthNotification({
        type: 'success',
        message: `Successfully connected ${provider}!`,
      });

      // Clear notification after 5 seconds
      setTimeout(() => setOauthNotification(null), 5000);

      // Clear URL parameters
      window.history.replaceState({}, '', '/dashboard');
    } else if (error) {
      setOauthNotification({
        type: 'error',
        message: `OAuth connection failed: ${error}`,
      });

      setTimeout(() => setOauthNotification(null), 5000);

      // Clear URL parameters
      window.history.replaceState({}, '', '/dashboard');
    }
  }, [searchParams]);

  const handleServiceConnect = (serviceId: string) => {
    setServices(prev =>
      prev.map(s =>
        s.id === serviceId ? { ...s, connected: true } : s
      )
    );
  };

  const handleServiceDisconnect = (serviceId: string) => {
    setServices(prev =>
      prev.map(s =>
        s.id === serviceId ? { ...s, connected: false } : s
      )
    );
  };

  const handleCommandExecuted = (command: string, result: any) => {
    setCommandHistory(prev => [{ command, result }, ...prev].slice(0, 10)); // Keep last 10
  };

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch (error) {
      console.error('Logout failed:', error);
      // Force logout even if API call fails
      window.location.href = '/login';
    }
  };

  const connectedCount = services.filter(s => s.connected).length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      {/* Navigation */}
      <nav className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-2 text-gray-600 hover:text-gray-900">
              <ArrowLeft className="w-5 h-5" />
              <span className="font-medium">Back</span>
            </Link>
            <div className="h-6 w-px bg-gray-300"></div>
            <div className="flex items-center gap-2">
              <Mic className="w-6 h-6 text-indigo-600" />
              <span className="text-xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                Voice Commander
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-600">
              <span className="font-semibold">{connectedCount}</span>
              <span> / {services.length} services connected</span>
            </div>

            {/* User Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowUserDropdown(!showUserDropdown)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center">
                  <User className="w-5 h-5 text-white" />
                </div>
                <span className="text-sm font-medium text-gray-700">{userEmail || 'Loading...'}</span>
                <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${showUserDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showUserDropdown && (
                <>
                  {/* Backdrop to close dropdown */}
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowUserDropdown(false)}
                  />

                  {/* Dropdown Menu */}
                  <div className="absolute right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 z-20">
                    <div className="px-4 py-3 border-b border-gray-100">
                      <p className="text-sm font-medium text-gray-900">Signed in as</p>
                      <p className="text-sm text-gray-600 truncate">{userEmail}</p>
                    </div>
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Logout</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* Tabs */}
      <div className="border-b bg-white/60 backdrop-blur-sm">
        <div className="container mx-auto px-4">
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab('voice')}
              className={`
                px-6 py-3 font-semibold transition-all border-b-2
                ${
                  activeTab === 'voice'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                }
              `}
            >
              <div className="flex items-center gap-2">
                <Mic className="w-5 h-5" />
                <span>Voice Commands</span>
              </div>
            </button>
            <button
              onClick={() => setActiveTab('services')}
              className={`
                px-6 py-3 font-semibold transition-all border-b-2
                ${
                  activeTab === 'services'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                }
              `}
            >
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5" />
                <span>Connected Services</span>
                {connectedCount > 0 && (
                  <span className="bg-green-500 text-white text-xs px-2 py-0.5 rounded-full">
                    {connectedCount}
                  </span>
                )}
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 py-8">
        {/* OAuth Notification */}
        {oauthNotification && (
          <div
            className={`mb-8 border rounded-lg p-4 ${
              oauthNotification.type === 'success'
                ? 'bg-green-50 border-green-200'
                : 'bg-red-50 border-red-200'
            }`}
          >
            <div className="flex items-start gap-3">
              {oauthNotification.type === 'success' ? (
                <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
              ) : (
                <XCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
              )}
              <div>
                <p
                  className={`font-medium ${
                    oauthNotification.type === 'success' ? 'text-green-900' : 'text-red-900'
                  }`}
                >
                  {oauthNotification.message}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Info Banner */}
        {connectedCount === 0 && !oauthNotification && (
          <div className="mb-8 bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Info className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-blue-900 mb-1">Welcome to Voice Commander!</h3>
                <p className="text-blue-800 text-sm">
                  To get started, connect at least one service in the <button onClick={() => setActiveTab('services')} className="underline font-medium">Connected Services</button> tab.
                  Then return here to start giving voice commands.
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'voice' ? (
          <div>
            {/* Voice Interface */}
            <VoiceInterface onCommandExecuted={handleCommandExecuted} />

            {/* Command History */}
            {commandHistory.length > 0 && (
              <div className="max-w-3xl mx-auto mt-12">
                <h2 className="text-2xl font-bold text-gray-900 mb-6">Recent Commands</h2>
                <div className="space-y-4">
                  {commandHistory.map((item, idx) => (
                    <div key={idx} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
                      <p className="text-gray-900 font-medium mb-1">&quot;{item.command}&quot;</p>
                      <p className="text-sm text-gray-600">{item.result.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="mb-8">
              <h2 className="text-3xl font-bold text-gray-900 mb-2">Connected Services</h2>
              <p className="text-gray-600">
                Connect your favorite apps to control them with voice commands
              </p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {services.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  onConnect={handleServiceConnect}
                  onDisconnect={handleServiceDisconnect}
                />
              ))}
            </div>

            {/* Info Section */}
            <div className="mt-12 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl p-8 border border-indigo-200">
              <h3 className="text-xl font-bold text-gray-900 mb-4">How to connect services</h3>
              <ol className="space-y-3 text-gray-700">
                <li className="flex items-start gap-3">
                  <span className="bg-indigo-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                    1
                  </span>
                  <span>Click the <strong>Connect</strong> button on any service card</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="bg-indigo-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                    2
                  </span>
                  <span>You&apos;ll be redirected to authorize Voice Commander</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="bg-indigo-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                    3
                  </span>
                  <span>After authorization, you&apos;ll be redirected back here</span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="bg-indigo-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0">
                    4
                  </span>
                  <span>Start giving voice commands to control your connected services!</span>
                </li>
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
