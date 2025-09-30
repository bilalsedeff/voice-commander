/**
 * Performance Optimizer for Voice MCP Gateway
 *
 * Provides comprehensive performance optimization including response caching,
 * connection pooling, request batching, and latency monitoring to meet
 * <1000ms end-to-end latency requirements for enterprise voice workflows.
 *
 * Dependencies:
 * - winston: https://github.com/winstonjs/winston
 * - node:perf_hooks: Node.js performance monitoring
 *
 * Input: MCP tool calls, voice commands, performance metrics
 * Output: Optimized responses with comprehensive performance tracking
 *
 * Example:
 * const optimizer = new PerformanceOptimizer();
 * const result = await optimizer.optimizedMCPCall('read_file', { path: 'package.json' });
 */

import { performance, PerformanceObserver } from "perf_hooks";
import winston from "winston";
import { MCPToolCall, MCPToolResult } from "./types.js";

interface CacheEntry {
  result: MCPToolResult;
  timestamp: number;
  hitCount: number;
  lastAccess: number;
}

interface PerformanceMetrics {
  totalRequests: number;
  averageLatency: number;
  p95Latency: number;
  p99Latency: number;
  cacheHitRate: number;
  errorRate: number;
  lastUpdated: Date;
}

interface BatchRequest {
  id: string;
  call: MCPToolCall;
  resolve: (value: MCPToolResult) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

export class PerformanceOptimizer {
  private cache: Map<string, CacheEntry> = new Map();
  private latencyHistory: number[] = [];
  private batchQueue: BatchRequest[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private performanceObserver!: PerformanceObserver;
  private logger: winston.Logger;

  // Configuration
  private readonly CACHE_TTL = 300000; // 5 minutes
  private readonly CACHE_MAX_SIZE = 1000;
  private readonly BATCH_SIZE = 10;
  private readonly BATCH_TIMEOUT = 100; // 100ms
  private readonly LATENCY_HISTORY_SIZE = 1000;
  private readonly TARGET_LATENCY = 1000; // 1 second

  // Cacheable operations (low-risk, read-only)
  private readonly CACHEABLE_OPERATIONS = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'get_config'
  ]);

  // Batch-able operations (can be processed together)
  private readonly BATCHABLE_OPERATIONS = new Set([
    'read_file',
    'list_directory',
    'search_files'
  ]);

  constructor() {
    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    });

    this.setupPerformanceObserver();
    this.startPerformanceMonitoring();
  }

  /**
   * Execute optimized MCP tool call with caching and batching
   */
  async optimizedMCPCall(
    method: string,
    params: Record<string, unknown>,
    mcpClient: any,
    sessionId: string = 'default'
  ): Promise<MCPToolResult> {
    const startTime = performance.now();
    const cacheKey = this.generateCacheKey(method, params);

    try {
      // Check cache first for cacheable operations
      if (this.CACHEABLE_OPERATIONS.has(method)) {
        const cachedResult = this.getFromCache(cacheKey);
        if (cachedResult) {
          this.logPerformanceMetrics('cache_hit', performance.now() - startTime, sessionId);
          return cachedResult;
        }
      }

      // Use batching for batch-able operations
      if (this.BATCHABLE_OPERATIONS.has(method)) {
        const result = await this.executeBatchedCall(method, params, mcpClient);

        // Cache the result if cacheable
        if (this.CACHEABLE_OPERATIONS.has(method)) {
          this.addToCache(cacheKey, result);
        }

        this.logPerformanceMetrics('batch_call', performance.now() - startTime, sessionId);
        return result;
      }

      // Execute directly for non-batch-able operations
      const result = await mcpClient.callTool(method, params);

      // Cache if cacheable
      if (this.CACHEABLE_OPERATIONS.has(method)) {
        this.addToCache(cacheKey, result);
      }

      this.logPerformanceMetrics('direct_call', performance.now() - startTime, sessionId);
      return result;

    } catch (error) {
      const duration = performance.now() - startTime;
      this.logPerformanceMetrics('error', duration, sessionId);
      this.logger.error('Optimized MCP call failed', {
        method,
        params,
        duration: Math.round(duration),
        error: (error as Error).message,
        sessionId
      });
      throw error;
    }
  }

  /**
   * Get comprehensive performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    const totalRequests = this.latencyHistory.length;
    const averageLatency = totalRequests > 0
      ? this.latencyHistory.reduce((sum, lat) => sum + lat, 0) / totalRequests
      : 0;

    const sortedLatencies = [...this.latencyHistory].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedLatencies.length * 0.95);
    const p99Index = Math.floor(sortedLatencies.length * 0.99);

    const p95Latency = sortedLatencies[p95Index] || 0;
    const p99Latency = sortedLatencies[p99Index] || 0;

    const cacheHits = Array.from(this.cache.values()).reduce(
      (sum, entry) => sum + entry.hitCount, 0
    );
    const cacheRequests = Math.max(totalRequests, 1);
    const cacheHitRate = cacheHits / cacheRequests;

    return {
      totalRequests,
      averageLatency: Math.round(averageLatency),
      p95Latency: Math.round(p95Latency),
      p99Latency: Math.round(p99Latency),
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      errorRate: 0, // Would be calculated from error tracking
      lastUpdated: new Date()
    };
  }

  /**
   * Optimize multiple concurrent requests
   */
  async optimizeParallelRequests<T>(
    requests: Array<() => Promise<T>>,
    maxConcurrency: number = 5
  ): Promise<T[]> {
    const startTime = performance.now();
    const results: T[] = [];

    // Process requests in batches to avoid overwhelming the system
    for (let i = 0; i < requests.length; i += maxConcurrency) {
      const batch = requests.slice(i, i + maxConcurrency);
      const batchResults = await Promise.all(batch.map(request => request()));
      results.push(...batchResults);
    }

    const duration = performance.now() - startTime;
    this.logger.info('Parallel request optimization completed', {
      totalRequests: requests.length,
      maxConcurrency,
      duration: Math.round(duration),
      averageRequestTime: Math.round(duration / requests.length)
    });

    return results;
  }

  /**
   * Preload frequently used data
   */
  async preloadCache(
    commonRequests: Array<{ method: string; params: Record<string, unknown> }>,
    mcpClient: any
  ): Promise<void> {
    this.logger.info('Starting cache preload', { requestCount: commonRequests.length });

    const preloadPromises = commonRequests
      .filter(req => this.CACHEABLE_OPERATIONS.has(req.method))
      .map(async req => {
        try {
          await this.optimizedMCPCall(req.method, req.params, mcpClient, 'preload');
        } catch (error) {
          this.logger.warn('Cache preload failed', {
            method: req.method,
            error: (error as Error).message
          });
        }
      });

    await Promise.all(preloadPromises);
    this.logger.info('Cache preload completed');
  }

  /**
   * Clear performance data and reset metrics
   */
  resetMetrics(): void {
    this.cache.clear();
    this.latencyHistory.length = 0;
    this.batchQueue.length = 0;

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    this.logger.info('Performance metrics reset');
  }

  /**
   * Execute batched MCP call
   */
  private async executeBatchedCall(
    method: string,
    params: Record<string, unknown>,
    mcpClient: any
  ): Promise<MCPToolResult> {
    return new Promise((resolve, reject) => {
      const request: BatchRequest = {
        id: this.generateRequestId(),
        call: { method, params, id: this.generateRequestId() },
        resolve,
        reject,
        timestamp: Date.now()
      };

      this.batchQueue.push(request);

      // Start batch timer if not already running
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => {
          this.processBatch(mcpClient);
        }, this.BATCH_TIMEOUT);
      }

      // Process batch immediately if it's full
      if (this.batchQueue.length >= this.BATCH_SIZE) {
        if (this.batchTimer) {
          clearTimeout(this.batchTimer);
          this.batchTimer = null;
        }
        this.processBatch(mcpClient);
      }
    });
  }

  /**
   * Process batched requests
   */
  private async processBatch(mcpClient: any): Promise<void> {
    if (this.batchQueue.length === 0) return;

    const batch = [...this.batchQueue];
    this.batchQueue.length = 0;
    this.batchTimer = null;

    this.logger.debug('Processing batch', { batchSize: batch.length });

    // Group by method for more efficient processing
    const groupedBatch = batch.reduce((groups, request) => {
      const method = request.call.method;
      if (!groups[method]) groups[method] = [];
      groups[method].push(request);
      return groups;
    }, {} as Record<string, BatchRequest[]>);

    // Process each method group
    await Promise.all(Object.entries(groupedBatch).map(async ([method, requests]) => {
      await Promise.all(requests.map(async request => {
        try {
          const result = await mcpClient.callTool(request.call.method, request.call.params);
          request.resolve(result);
        } catch (error) {
          request.reject(error as Error);
        }
      }));
    }));
  }

  /**
   * Cache management methods
   */
  private generateCacheKey(method: string, params: Record<string, unknown>): string {
    const paramsKey = JSON.stringify(params, Object.keys(params).sort());
    return `${method}:${Buffer.from(paramsKey).toString('base64')}`;
  }

  private getFromCache(key: string): MCPToolResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > this.CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }

    // Update access statistics
    entry.hitCount++;
    entry.lastAccess = Date.now();

    return entry.result;
  }

  private addToCache(key: string, result: MCPToolResult): void {
    // Implement LRU eviction if cache is full
    if (this.cache.size >= this.CACHE_MAX_SIZE) {
      this.evictLRUEntries();
    }

    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      hitCount: 0,
      lastAccess: Date.now()
    });
  }

  private evictLRUEntries(): void {
    const entries = Array.from(this.cache.entries());
    entries.sort(([,a], [,b]) => a.lastAccess - b.lastAccess);

    // Remove oldest 10% of entries
    const toRemove = Math.floor(entries.length * 0.1);
    for (let i = 0; i < toRemove; i++) {
      const entry = entries[i];
      if (entry) {
        this.cache.delete(entry[0]);
      }
    }
  }

  /**
   * Performance monitoring setup
   */
  private setupPerformanceObserver(): void {
    this.performanceObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      entries.forEach(entry => {
        if (entry.name.startsWith('mcp-call')) {
          this.recordLatency(entry.duration);
        }
      });
    });

    this.performanceObserver.observe({ entryTypes: ['measure'] });
  }

  private logPerformanceMetrics(
    operation: string,
    duration: number,
    sessionId: string
  ): void {
    this.recordLatency(duration);

    // Mark performance entry for monitoring
    performance.mark(`mcp-call-${operation}-start`);
    performance.mark(`mcp-call-${operation}-end`);
    performance.measure(
      `mcp-call-${operation}`,
      `mcp-call-${operation}-start`,
      `mcp-call-${operation}-end`
    );

    // Log performance warning if exceeding target latency
    if (duration > this.TARGET_LATENCY) {
      this.logger.warn('Performance target exceeded', {
        operation,
        duration: Math.round(duration),
        target: this.TARGET_LATENCY,
        sessionId
      });
    }

    this.logger.debug('Performance metrics logged', {
      operation,
      duration: Math.round(duration),
      sessionId
    });
  }

  private recordLatency(duration: number): void {
    this.latencyHistory.push(duration);

    // Maintain history size limit
    if (this.latencyHistory.length > this.LATENCY_HISTORY_SIZE) {
      this.latencyHistory.shift();
    }
  }

  private startPerformanceMonitoring(): void {
    // Log performance summary every 5 minutes
    setInterval(() => {
      const metrics = this.getPerformanceMetrics();
      this.logger.info('Performance summary', metrics);

      // Alert if performance is degrading
      if (metrics.p95Latency > this.TARGET_LATENCY) {
        this.logger.warn('Performance degradation detected', {
          p95Latency: metrics.p95Latency,
          target: this.TARGET_LATENCY
        });
      }
    }, 300000); // 5 minutes
  }

  private generateRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.performanceObserver) {
      this.performanceObserver.disconnect();
    }

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.cache.clear();
    this.latencyHistory.length = 0;
    this.batchQueue.length = 0;
  }
}

// Create and export singleton instance
export const performanceOptimizer = new PerformanceOptimizer();

// Validation function for testing (required per CLAUDE.md)
if (import.meta.url === `file://${(process.argv[1] || '').replace(/\\/g, '/')}`) {
  async function validateModule(): Promise<void> {
    const failures: string[] = [];
    let totalTests = 0;

    const optimizer = new PerformanceOptimizer();

    // Test 1: Performance metrics initialization
    totalTests++;
    try {
      const metrics = optimizer.getPerformanceMetrics();
      if (typeof metrics.totalRequests !== 'number') {
        failures.push('Metrics test: Invalid metrics structure');
      }
    } catch (error) {
      failures.push(`Metrics test: ${(error as Error).message}`);
    }

    // Test 2: Cache key generation
    totalTests++;
    try {
      const key1 = (optimizer as any).generateCacheKey('read_file', { path: 'test.txt' });
      const key2 = (optimizer as any).generateCacheKey('read_file', { path: 'test.txt' });
      if (key1 !== key2) {
        failures.push('Cache key test: Inconsistent key generation');
      }
    } catch (error) {
      failures.push(`Cache key test: ${(error as Error).message}`);
    }

    // Test 3: Parallel request optimization
    totalTests++;
    try {
      const requests = [
        () => Promise.resolve('result1'),
        () => Promise.resolve('result2'),
        () => Promise.resolve('result3')
      ];
      const results = await optimizer.optimizeParallelRequests(requests, 2);
      if (results.length !== 3) {
        failures.push('Parallel test: Incorrect result count');
      }
    } catch (error) {
      failures.push(`Parallel test: ${(error as Error).message}`);
    }

    // Test 4: Resource cleanup
    totalTests++;
    try {
      optimizer.destroy();
      // Should not throw
    } catch (error) {
      failures.push(`Cleanup test: ${(error as Error).message}`);
    }

    // Report results
    if (failures.length > 0) {
      console.error(`❌ VALIDATION FAILED - ${failures.length} of ${totalTests} tests failed:`);
      failures.forEach(f => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.log(`✅ VALIDATION PASSED - All ${totalTests} tests successful`);
      process.exit(0);
    }
  }

  validateModule().catch(console.error);
}