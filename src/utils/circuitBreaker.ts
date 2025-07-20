// src/utils/CircuitBreaker.ts - Circuit breaker pattern for failing printers
import logger from './logger';

export enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Failing, reject all requests
  HALF_OPEN = 'HALF_OPEN' // Testing if service recovered
}

export interface CircuitBreakerOptions {
  failureThreshold: number;    // Number of failures before opening
  resetTimeout: number;        // Time before attempting reset (ms)
  monitoringPeriod: number;    // Time window for failure counting (ms)
  successThreshold: number;    // Successes needed to close from half-open
}

export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private totalRequests: number = 0;
  private totalFailures: number = 0;
  private totalSuccesses: number = 0;
  private nextAttempt: number = 0;

  constructor(
    private name: string,
    private options: CircuitBreakerOptions = {
      failureThreshold: 5,
      resetTimeout: 60000, // 1 minute
      monitoringPeriod: 300000, // 5 minutes
      successThreshold: 3
    }
  ) {}

  public async execute<T>(operation: () => Promise<T>): Promise<T> {
    this.totalRequests++;
    
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        throw new Error(`Circuit breaker is OPEN for ${this.name}. Next attempt in ${Math.round((this.nextAttempt - Date.now()) / 1000)}s`);
      } else {
        // Transition to half-open
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
        logger.info(`Circuit breaker ${this.name} transitioning to HALF_OPEN`);
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.lastSuccessTime = Date.now();
    this.totalSuccesses++;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this.reset();
        logger.info(`Circuit breaker ${this.name} CLOSED after successful recovery`);
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();
    this.totalFailures++;
    this.failureCount++;

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open immediately opens the circuit
      this.open();
      logger.warn(`Circuit breaker ${this.name} OPENED due to failure in HALF_OPEN state`);
    } else if (this.state === CircuitState.CLOSED) {
      // Clean up old failures outside monitoring period
      const monitoringWindow = Date.now() - this.options.monitoringPeriod;
      if (this.lastFailureTime && this.lastFailureTime < monitoringWindow) {
        this.failureCount = 1; // Reset count and start fresh
      }

      if (this.failureCount >= this.options.failureThreshold) {
        this.open();
        logger.warn(`Circuit breaker ${this.name} OPENED due to ${this.failureCount} failures`);
      }
    }
  }

  private open(): void {
    this.state = CircuitState.OPEN;
    this.nextAttempt = Date.now() + this.options.resetTimeout;
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttempt = 0;
  }

  public getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses
    };
  }

  public getCurrentState(): CircuitState {
    return this.state;
  }

  public isAvailable(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }
    
    if (this.state === CircuitState.OPEN && Date.now() >= this.nextAttempt) {
      return true; // Will transition to half-open on next call
    }
    
    return this.state === CircuitState.HALF_OPEN;
  }

  public forceClose(): void {
    this.reset();
    logger.info(`Circuit breaker ${this.name} manually CLOSED`);
  }

  public forceOpen(): void {
    this.open();
    logger.info(`Circuit breaker ${this.name} manually OPENED`);
  }
}

// Circuit breaker manager for multiple printers
export class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker> = new Map();
  private defaultOptions: CircuitBreakerOptions;

  constructor(options?: Partial<CircuitBreakerOptions>) {
    this.defaultOptions = {
      failureThreshold: 5,
      resetTimeout: 60000,
      monitoringPeriod: 300000,
      successThreshold: 3,
      ...options
    };
  }

  public getBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
    if (!this.breakers.has(name)) {
      const breakerOptions = options || this.defaultOptions;
      this.breakers.set(name, new CircuitBreaker(name, breakerOptions));
    }
    return this.breakers.get(name)!;
  }

  public async executeWithBreaker<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const breaker = this.getBreaker(name);
    return breaker.execute(operation);
  }

  public getAllStats(): Record<string, CircuitBreakerStats> {
    const stats: Record<string, CircuitBreakerStats> = {};
    for (const [name, breaker] of this.breakers) {
      stats[name] = breaker.getStats();
    }
    return stats;
  }

  public getAvailableBreakers(): string[] {
    return Array.from(this.breakers.entries())
      .filter(([_, breaker]) => breaker.isAvailable())
      .map(([name, _]) => name);
  }

  public getUnavailableBreakers(): string[] {
    return Array.from(this.breakers.entries())
      .filter(([_, breaker]) => !breaker.isAvailable())
      .map(([name, _]) => name);
  }

  public resetBreaker(name: string): void {
    const breaker = this.breakers.get(name);
    if (breaker) {
      breaker.forceClose();
    }
  }

  public resetAllBreakers(): void {
    for (const breaker of this.breakers.values()) {
      breaker.forceClose();
    }
    logger.info('All circuit breakers reset');
  }
}