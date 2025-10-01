/**
 * PKCE (Proof Key for Code Exchange) Utility
 *
 * Implements OAuth 2.0 PKCE flow for secure authorization.
 * Generates code verifier and challenge using SHA-256 hashing.
 *
 * Dependencies:
 * - crypto: Node.js built-in crypto module
 *
 * Input: None (generates random values)
 * Output: PKCE code verifier and challenge pair
 *
 * Example:
 * const { codeVerifier, codeChallenge } = generatePKCE();
 * // Use codeChallenge in authorization URL
 * // Store codeVerifier for token exchange
 */

import crypto from 'crypto';

/**
 * PKCE parameters interface
 */
export interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * Generate PKCE code verifier and challenge
 *
 * Code verifier: 43-128 character random string (base64url encoded)
 * Code challenge: SHA-256 hash of code verifier (base64url encoded)
 *
 * @returns PKCE parameters with verifier and challenge
 */
export function generatePKCE(): PKCEParams {
  // Generate 32-byte random code verifier (43 characters in base64url)
  const codeVerifier = crypto
    .randomBytes(32)
    .toString('base64url');

  // Generate code challenge using SHA-256
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256'
  };
}

/**
 * Generate cryptographically secure state parameter
 *
 * State parameter prevents CSRF attacks by validating OAuth callback
 *
 * @returns Random state string
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Validate code verifier format
 *
 * Must be 43-128 characters, base64url encoded
 *
 * @param verifier - Code verifier to validate
 * @returns True if valid
 */
export function isValidCodeVerifier(verifier: string): boolean {
  if (!verifier) return false;

  const length = verifier.length;
  if (length < 43 || length > 128) return false;

  // Check base64url format (alphanumeric, dash, underscore only)
  const base64urlPattern = /^[A-Za-z0-9_-]+$/;
  return base64urlPattern.test(verifier);
}

/**
 * Verify code challenge matches code verifier
 *
 * Used to validate PKCE flow during token exchange
 *
 * @param verifier - Original code verifier
 * @param challenge - Code challenge from authorization request
 * @returns True if challenge matches verifier
 */
export function verifyPKCE(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;

  const computedChallenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');

  return computedChallenge === challenge;
}
