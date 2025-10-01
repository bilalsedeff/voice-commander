/**
 * AES-256 Encryption Utility for OAuth Tokens
 *
 * Provides secure encryption/decryption for sensitive OAuth tokens stored in database.
 * Uses AES-256-CBC algorithm with random IV for each encryption operation.
 *
 * Dependencies:
 * - crypto: Node.js built-in crypto module
 *
 * Input: Plain text string, encryption key from environment
 * Output: Encrypted string (base64) or decrypted plain text
 *
 * Example:
 * const encrypted = encryptToken("my-oauth-token");
 * const decrypted = decryptToken(encrypted);
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; // AES block size

/**
 * Get encryption key from environment variable
 * Must be 32 characters (256 bits) for AES-256
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;

  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }

  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be exactly 32 characters for AES-256');
  }

  return Buffer.from(key, 'utf-8');
}

/**
 * Encrypt sensitive text (OAuth tokens)
 *
 * @param text - Plain text to encrypt
 * @returns Encrypted text in format: iv:encryptedData (both base64)
 */
export function encryptToken(text: string): string {
  if (!text) {
    throw new Error('Text to encrypt is required');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  // Return IV:encrypted format
  return `${iv.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt sensitive text (OAuth tokens)
 *
 * @param encryptedText - Encrypted text in format: iv:encryptedData
 * @returns Decrypted plain text
 */
export function decryptToken(encryptedText: string): string {
  if (!encryptedText) {
    throw new Error('Encrypted text is required');
  }

  const parts = encryptedText.split(':');

  if (parts.length !== 2) {
    throw new Error('Invalid encrypted text format (expected iv:encryptedData)');
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(parts[0], 'base64');
  const encrypted = parts[1];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Generate a secure random encryption key (32 characters)
 * Use this to generate ENCRYPTION_KEY for .env file
 */
export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('hex').substring(0, 32);
}

// Validation function for testing
if (require.main === module) {
  console.log('🔐 Testing encryption utility...\n');

  try {
    // Test 1: Generate encryption key
    console.log('Test 1: Generate encryption key');
    const newKey = generateEncryptionKey();
    console.log(`✓ Generated key: ${newKey} (length: ${newKey.length})`);

    // Set test encryption key
    process.env.ENCRYPTION_KEY = newKey;

    // Test 2: Encrypt and decrypt
    console.log('\nTest 2: Encrypt and decrypt');
    const originalText = 'test-oauth-token-12345';
    const encrypted = encryptToken(originalText);
    console.log(`✓ Encrypted: ${encrypted}`);

    const decrypted = decryptToken(encrypted);
    console.log(`✓ Decrypted: ${decrypted}`);

    if (decrypted !== originalText) {
      throw new Error('Encryption/decryption failed - text mismatch');
    }

    // Test 3: Different IVs produce different ciphertext
    console.log('\nTest 3: Unique IVs for same text');
    const encrypted1 = encryptToken(originalText);
    const encrypted2 = encryptToken(originalText);

    if (encrypted1 === encrypted2) {
      throw new Error('Same IV reused - security risk!');
    }

    console.log(`✓ Different ciphertexts: ${encrypted1.substring(0, 30)}... vs ${encrypted2.substring(0, 30)}...`);

    // Test 4: Error handling
    console.log('\nTest 4: Error handling');
    try {
      decryptToken('invalid-format');
      throw new Error('Should have thrown error for invalid format');
    } catch (error) {
      if ((error as Error).message.includes('Invalid encrypted text format')) {
        console.log('✓ Invalid format error handled correctly');
      } else {
        throw error;
      }
    }

    console.log('\n✅ All encryption tests passed!');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Encryption test failed:', (error as Error).message);
    process.exit(1);
  }
}
