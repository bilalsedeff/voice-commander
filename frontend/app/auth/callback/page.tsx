'use client';

import { useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * OAuth Callback Handler
 *
 * Handles the OAuth callback from social providers (Google, GitHub)
 * Extracts tokens from URL and stores them in localStorage
 */
export default function AuthCallbackPage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const handleCallback = () => {
      const accessToken = searchParams.get('access_token');
      const refreshToken = searchParams.get('refresh_token');
      const expiresIn = searchParams.get('expires_in');
      const isNewUser = searchParams.get('is_new_user');

      if (accessToken && refreshToken && expiresIn) {
        // Store tokens in localStorage
        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', refreshToken);
        localStorage.setItem('tokenExpiry', (Date.now() + parseInt(expiresIn)).toString());

        // Redirect to dashboard
        router.push('/dashboard');
      } else {
        // Missing tokens, redirect to login with error
        router.push('/login?error=Authentication+failed');
      }
    };

    handleCallback();
  }, [searchParams, router]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex items-center justify-center">
      <div className="text-center">
        <Loader2 className="w-12 h-12 text-indigo-600 animate-spin mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-gray-900">Completing sign in...</h2>
        <p className="text-gray-600 mt-2">Please wait while we redirect you</p>
      </div>
    </div>
  );
}
