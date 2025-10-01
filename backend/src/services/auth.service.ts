/**
 * Authentication Service
 *
 * Handles user registration, login, token refresh, and password management.
 * Implements secure password hashing with bcrypt and JWT token generation.
 *
 * Dependencies:
 * - bcrypt: https://github.com/kelektiv/node.bcrypt.js
 * - @prisma/client: Database ORM
 * - @/utils/jwt: JWT utilities
 * - @/utils/logger: Winston logger
 *
 * Input: User credentials, registration data
 * Output: User data with JWT tokens or error messages
 *
 * Example:
 * const result = await authService.register({ email, password, name });
 * const loginResult = await authService.login({ email, password });
 */

import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/database';
import { generateTokens, verifyRefreshToken, TokenPair } from '../utils/jwt';
import logger from '../utils/logger';

const BCRYPT_ROUNDS = 12;

// DTOs (Data Transfer Objects)
export interface RegisterDTO {
  email: string;
  password: string;
  name: string;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface RefreshTokenDTO {
  refreshToken: string;
}

export interface UserResponse {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
}

export interface AuthResponse {
  user: UserResponse;
  tokens: TokenPair;
}

/**
 * Register a new user
 *
 * @param data - Registration data (email, password, name)
 * @returns User data with JWT tokens
 * @throws Error if email already exists or validation fails
 */
export async function register(data: RegisterDTO): Promise<AuthResponse> {
  try {
    // Validate input
    if (!data.email || !data.password || !data.name) {
      throw new Error('Email, password, and name are required');
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      throw new Error('Invalid email format');
    }

    // Validate password strength
    if (data.password.length < 8) {
      throw new Error('Password must be at least 8 characters long');
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() }
    });

    if (existingUser) {
      throw new Error('Email already registered');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, BCRYPT_ROUNDS);

    // Create user
    const user = await prisma.user.create({
      data: {
        id: uuidv4(),
        email: data.email.toLowerCase(),
        password: hashedPassword,
        name: data.name
      },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true
      }
    });

    // Generate tokens
    const tokens = generateTokens({
      userId: user.id,
      email: user.email
    });

    // Store refresh token in database
    await prisma.session.create({
      data: {
        id: uuidv4(),
        userId: user.id,
        token: tokens.accessToken.substring(0, 50), // Store hash instead of full token
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(Date.now() + tokens.expiresIn),
        lastActivity: new Date()
      }
    });

    logger.info('User registered successfully', {
      userId: user.id,
      email: user.email
    });

    return {
      user,
      tokens
    };

  } catch (error) {
    logger.error('User registration failed', {
      email: data.email,
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Login existing user
 *
 * @param data - Login credentials (email, password)
 * @returns User data with JWT tokens
 * @throws Error if credentials are invalid
 */
export async function login(data: LoginDTO): Promise<AuthResponse> {
  try {
    // Validate input
    if (!data.email || !data.password) {
      throw new Error('Email and password are required');
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: data.email.toLowerCase() }
    });

    if (!user) {
      throw new Error('Invalid email or password');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(data.password, user.password);

    if (!isPasswordValid) {
      throw new Error('Invalid email or password');
    }

    // Generate tokens
    const tokens = generateTokens({
      userId: user.id,
      email: user.email
    });

    // Store refresh token in database
    await prisma.session.create({
      data: {
        id: uuidv4(),
        userId: user.id,
        token: tokens.accessToken.substring(0, 50),
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(Date.now() + tokens.expiresIn),
        lastActivity: new Date()
      }
    });

    logger.info('User logged in successfully', {
      userId: user.id,
      email: user.email
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt
      },
      tokens
    };

  } catch (error) {
    logger.error('User login failed', {
      email: data.email,
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Refresh access token using refresh token
 *
 * @param data - Refresh token
 * @returns New token pair
 * @throws Error if refresh token is invalid or expired
 */
export async function refreshAccessToken(data: RefreshTokenDTO): Promise<TokenPair> {
  try {
    // Validate input
    if (!data.refreshToken) {
      throw new Error('Refresh token is required');
    }

    // Verify refresh token
    const payload = verifyRefreshToken(data.refreshToken);

    // Check if session exists in database
    const session = await prisma.session.findFirst({
      where: {
        refreshToken: data.refreshToken,
        userId: payload.userId
      }
    });

    if (!session) {
      throw new Error('Invalid refresh token');
    }

    // Check if session expired
    if (session.expiresAt < new Date()) {
      await prisma.session.delete({ where: { id: session.id } });
      throw new Error('Refresh token expired');
    }

    // Generate new tokens
    const newTokens = generateTokens({
      userId: payload.userId,
      email: payload.email
    });

    // Update session with new tokens
    await prisma.session.update({
      where: { id: session.id },
      data: {
        token: newTokens.accessToken.substring(0, 50),
        refreshToken: newTokens.refreshToken,
        expiresAt: new Date(Date.now() + newTokens.expiresIn),
        lastActivity: new Date()
      }
    });

    logger.info('Access token refreshed successfully', {
      userId: payload.userId
    });

    return newTokens;

  } catch (error) {
    logger.error('Token refresh failed', {
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Logout user (invalidate refresh token)
 *
 * @param refreshToken - Refresh token to invalidate
 */
export async function logout(refreshToken: string): Promise<void> {
  try {
    if (!refreshToken) {
      return;
    }

    // Delete session from database
    await prisma.session.deleteMany({
      where: { refreshToken }
    });

    logger.info('User logged out successfully');

  } catch (error) {
    logger.error('Logout failed', {
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Get user profile by ID
 *
 * @param userId - User ID
 * @returns User profile data
 */
export async function getUserProfile(userId: string): Promise<UserResponse> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true
      }
    });

    if (!user) {
      throw new Error('User not found');
    }

    return user;

  } catch (error) {
    logger.error('Get user profile failed', {
      userId,
      error: (error as Error).message
    });
    throw error;
  }
}

/**
 * Clean up expired sessions (run periodically)
 */
export async function cleanupExpiredSessions(): Promise<void> {
  try {
    const result = await prisma.session.deleteMany({
      where: {
        expiresAt: {
          lt: new Date()
        }
      }
    });

    logger.info('Expired sessions cleaned up', {
      count: result.count
    });

  } catch (error) {
    logger.error('Session cleanup failed', {
      error: (error as Error).message
    });
  }
}
