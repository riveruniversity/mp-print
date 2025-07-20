// src/services/PrinterCache.ts - Non-blocking printer status with caching
import { PrinterStatus, PrinterStatusType } from '../types';
import { CircuitBreakerManager } from '../utils/circuitBreaker';
import { PrinterWorkerPool } from '../workers/printerWorker';
import logger from '../utils/logger';

export interface CachedPrinterStatus extends PrinterStatus {
  lastUpdated: number;
  cacheValid: boolean;
  consecutiveFailures: number;
  lastHealthCheck: number;
}

export interface PrinterCacheOptions {
  cacheValidityMs: number;      // How long cache remains valid
  maxConsecutiveFailures: number; // Circuit breaker threshold
  healthCheckIntervalMs: number;  // Background health check frequency
  staleDataTimeoutMs: number;     // When to serve stale data vs error
  maxConcurrentChecks: number;    // Limit concurrent health checks
}

export class PrinterCache {
  private cache: Map<string, CachedPrinterStatus> = new Map();
  private workerPool: PrinterWorkerPool;
  private circuitBreaker: CircuitBreakerManager;
  private healthCheckInterval?: NodeJS.Timeout;
  private pendingHealthChecks: Set<string> = new Set();
  private lastFullDiscovery: number = 0;
  private isShuttingDown: boolean = false;

  private readonly options: PrinterCacheOptions = {
    cacheValidityMs: 30000,        // 30 seconds cache validity
    maxConsecutiveFailures: 3,      // Open circuit after 3 failures
    healthCheckIntervalMs: 120000,  // 2 minutes between background checks
    staleDataTimeoutMs: 300000,     // 5 minutes before considering data too stale
    maxConcurrentChecks: 2          // Max 2 concurrent health checks
  };

  constructor(
    workerPool: PrinterWorkerPool,
    options?: Partial<PrinterCacheOptions>
  ) {
    this.workerPool = workerPool;
    this.circuitBreaker = new CircuitBreakerManager({
      failureThreshold: options?.maxConsecutiveFailures || this.options.maxConsecutiveFailures,
      resetTimeout: 120000, // 2 minutes
      monitoringPeriod: 600000, // 10 minutes
      successThreshold: 2
    });
    
    Object.assign(this.options, options);
    this.startBackgroundHealthCheck();
  }

  public async initialize(): Promise<void> {
    logger.info('Initializing printer cache...');
    try {
      await this.performFullDiscovery();
      logger.info(`✅ Printer cache initialized with ${this.cache.size} printers`);
    } catch (error) {
      logger.error('Failed to initialize printer cache:', error);
      // Don't throw - service can still run with empty cache
    }
  }

  private async performFullDiscovery(): Promise<void> {
    try {
      const discoveredPrinters = await this.circuitBreaker.executeWithBreaker(
        'printer_discovery',
        () => this.workerPool.discoverPrinters()
      );

      const now = Date.now();
      this.lastFullDiscovery = now;

      // Update cache with discovered printers
      const newPrinterNames = new Set<string>();
      
      for (const printer of discoveredPrinters) {
        newPrinterNames.add(printer.name);
        
        const existing = this.cache.get(printer.name);
        const cachedPrinter: CachedPrinterStatus = {
          ...printer,
          lastUpdated: now,
          cacheValid: true,
          consecutiveFailures: existing?.consecutiveFailures || 0,
          lastHealthCheck: now
        };
        
        this.cache.set(printer.name, cachedPrinter);
      }

      // Mark printers not found in discovery as offline
      for (const [name, cached] of this.cache) {
        if (!newPrinterNames.has(name)) {
          cached.status = 'offline';
          cached.lastUpdated = now;
          cached.cacheValid = false;
          logger.warn(`Printer ${name} no longer found in system`);
        }
      }

      logger.info(`Printer discovery completed: ${discoveredPrinters.length} printers found`);
      
    } catch (error) {
      logger.error('Full printer discovery failed:', error);
      // Mark all cached data as potentially stale
      for (const cached of this.cache.values()) {
        cached.cacheValid = false;
      }
    }
  }

  public async getPrinterStatus(printerName: string): Promise<CachedPrinterStatus | null> {
    const cached = this.cache.get(printerName);
    const now = Date.now();

    // If no cached data exists, try immediate discovery
    if (!cached) {
      await this.refreshPrinterIfNeeded(printerName);
      return this.cache.get(printerName) || null;
    }

    // Check if cache is still valid
    const cacheAge = now - cached.lastUpdated;
    const isValid = cached.cacheValid && cacheAge < this.options.cacheValidityMs;

    if (isValid) {
      return cached;
    }

    // If cache is stale but not too old, refresh in background and return stale data
    if (cacheAge < this.options.staleDataTimeoutMs) {
      // Non-blocking refresh
      setImmediate(() => this.refreshPrinterIfNeeded(printerName));
      return cached; // Return stale data immediately
    }

    // Data is too stale, force refresh
    await this.refreshPrinterIfNeeded(printerName);
    return this.cache.get(printerName) || null;
  }

  public getAllPrinters(): CachedPrinterStatus[] {
    const now = Date.now();
    const printers = Array.from(this.cache.values());

    // Trigger background refresh for stale printers (non-blocking)
    setImmediate(() => {
      for (const printer of printers) {
        const cacheAge = now - printer.lastUpdated;
        if (!printer.cacheValid || cacheAge > this.options.cacheValidityMs) {
          this.refreshPrinterIfNeeded(printer.name);
        }
      }
    });

    return printers;
  }

  public getOnlinePrinters(): CachedPrinterStatus[] {
    return this.getAllPrinters().filter(printer => {
      // Only consider online if:
      // 1. Status is online
      // 2. Circuit breaker allows requests
      // 3. Not too many consecutive failures
      return printer.status === 'online' && 
             this.circuitBreaker.getBreaker(printer.name).isAvailable() &&
             printer.consecutiveFailures < this.options.maxConsecutiveFailures;
    });
  }

  private async refreshPrinterIfNeeded(printerName: string): Promise<void> {
    // Prevent concurrent health checks for same printer
    if (this.pendingHealthChecks.has(printerName)) {
      return;
    }

    // Limit total concurrent health checks
    if (this.pendingHealthChecks.size >= this.options.maxConcurrentChecks) {
      return;
    }

    this.pendingHealthChecks.add(printerName);

    try {
      const status = await this.circuitBreaker.executeWithBreaker(
        printerName,
        () => this.workerPool.checkPrinterHealth(printerName)
      );

      const cached = this.cache.get(printerName);
      if (cached) {
        cached.status = status;
        cached.lastUpdated = Date.now();
        cached.lastHealthCheck = Date.now();
        cached.cacheValid = true;
        cached.consecutiveFailures = 0; // Reset on success
      }

    } catch (error) {
      const cached = this.cache.get(printerName);
      if (cached) {
        cached.status = 'error';
        cached.lastHealthCheck = Date.now();
        cached.cacheValid = false;
        cached.consecutiveFailures++;
      }
      
      logger.debug(`Health check failed for printer ${printerName}:`, error);
    } finally {
      this.pendingHealthChecks.delete(printerName);
    }
  }

  private startBackgroundHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      if (this.isShuttingDown) {
        return;
      }
      
      this.performBackgroundMaintenance();
    }, this.options.healthCheckIntervalMs);
  }

  private async performBackgroundMaintenance(): Promise<void> {
    const now = Date.now();
    
    // Perform full discovery every 10 minutes
    const timeSinceDiscovery = now - this.lastFullDiscovery;
    if (timeSinceDiscovery > 600000) { // 10 minutes
      logger.debug('Performing background printer discovery...');
      await this.performFullDiscovery();
      return;
    }

    // Health check a subset of printers
    const printersToCheck = Array.from(this.cache.values())
      .filter(printer => {
        const timeSinceCheck = now - printer.lastHealthCheck;
        return timeSinceCheck > this.options.healthCheckIntervalMs && 
               !this.pendingHealthChecks.has(printer.name);
      })
      .sort((a, b) => a.lastHealthCheck - b.lastHealthCheck) // Oldest first
      .slice(0, 2); // Check max 2 printers per cycle

    for (const printer of printersToCheck) {
      // Non-blocking health check
      setImmediate(() => this.refreshPrinterIfNeeded(printer.name));
    }
  }

  public async forceRefreshPrinter(printerName: string): Promise<void> {
    // Remove from pending to allow immediate refresh
    this.pendingHealthChecks.delete(printerName);
    await this.refreshPrinterIfNeeded(printerName);
  }

  public async forceFullRefresh(): Promise<void> {
    logger.info('Forcing full printer cache refresh...');
    await this.performFullDiscovery();
  }

  public isPrinterAvailable(printerName: string): boolean {
    const cached = this.cache.get(printerName);
    if (!cached) {
      return false;
    }

    return cached.status === 'online' && 
           this.circuitBreaker.getBreaker(printerName).isAvailable() &&
           cached.consecutiveFailures < this.options.maxConsecutiveFailures;
  }

  public getCacheStats(): any {
    const now = Date.now();
    const printers = Array.from(this.cache.values());
    
    return {
      totalPrinters: printers.length,
      onlinePrinters: printers.filter(p => p.status === 'online').length,
      offlinePrinters: printers.filter(p => p.status === 'offline').length,
      errorPrinters: printers.filter(p => p.status === 'error').length,
      validCache: printers.filter(p => p.cacheValid).length,
      staleCache: printers.filter(p => !p.cacheValid).length,
      avgCacheAge: printers.length > 0 ? 
        Math.round(printers.reduce((sum, p) => sum + (now - p.lastUpdated), 0) / printers.length / 1000) : 0,
      pendingHealthChecks: this.pendingHealthChecks.size,
      lastFullDiscovery: this.lastFullDiscovery,
      circuitBreakerStats: this.circuitBreaker.getAllStats()
    };
  }

  public destroy(): void {
    this.isShuttingDown = true;
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    this.pendingHealthChecks.clear();
    this.cache.clear();
    
    logger.info('Printer cache destroyed');
  }
}