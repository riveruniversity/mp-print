// src/services/PrintService.ts - Enhanced Singleton with Ultra-Optimization Support

import { PrinterService } from './PrinterService';
import { QueueService } from './QueueService';
import { PrintRequest, ServerMetrics, PrintJob, QueueStatus, PrinterStatus } from '../types';
import { config } from '../config';
import logger from '../utils/logger';

export class PrintService {
  private static instance: PrintService;
  private static isInitialized: boolean = false;
  
  private printerService: PrinterService;
  private queueService: QueueService;
  private processingInterval?: ReturnType<typeof setInterval>;
  private metricsInterval?: ReturnType<typeof setInterval>;
  private metrics: ServerMetrics = {
    totalJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    averageProcessingTime: 0,
    queueLength: 0,
    activePrinters: 0
  };

  // Ultra-optimization tracking
  private ultraOptimizationMetrics = {
    totalUltraOptimizedJobs: 0,
    averageUltraOptimizedTime: 0,
    puppeteerFallbackCount: 0,
    wkhtmltopdfFallbackCount: 0,
    lastOptimizationCheck: Date.now()
  };

  private constructor() {
    this.printerService = new PrinterService();
    this.queueService = new QueueService();
    this.setupEventListeners();
  }

  public static getInstance(): PrintService {
    if (!PrintService.instance) {
      PrintService.instance = new PrintService();
    }
    return PrintService.instance;
  }

  public async initialize(): Promise<void> {
    if (PrintService.isInitialized) {
      logger.info('PrintService already initialized, skipping...');
      return;
    }

    try {
      logger.info('Initializing PrintService singleton with ultra-optimization...');
      await this.printerService.initialize();
      this.startProcessing();
      this.startMetricsCollection();
      
      PrintService.isInitialized = true;
      logger.info('✅ PrintService singleton initialized successfully with ultra-optimization support');
    } catch (error) {
      logger.error('❌ Failed to initialize PrintService singleton:', error);
      throw error;
    }
  }

  private setupEventListeners(): void {
    this.queueService.on('jobCompleted', (): void => {
      this.metrics.completedJobs++;
    });

    this.queueService.on('jobFailed', (): void => {
      this.metrics.failedJobs++;
    });
  }

  private startProcessing(): void {
    this.processingInterval = setInterval(async (): Promise<void> => {
      await this.processJobs();
    }, 1000);
  }

  private startMetricsCollection(): void {
    this.metricsInterval = setInterval((): void => {
      this.updateMetrics();
    }, 5000);
  }

  private async processJobs(): Promise<void> {
    const queueStatus: QueueStatus = this.queueService.getQueueStatus();
    const availableSlots: number = config.printing.maxConcurrentJobs - queueStatus.processing;
    if (availableSlots <= 0) return;

    const jobs: PrintJob[] = this.queueService.getNextJobs(
      Math.min(availableSlots, config.printing.batchSize)
    );

    const processingPromises: Promise<void>[] = jobs.map((job: PrintJob): Promise<void> =>
      this.processJob(job)
    );
    await Promise.allSettled(processingPromises);
  }

  private async processJob(job: PrintJob): Promise<void> {
    const { request }: { request: PrintRequest; } = job;
    const startTime: number = Date.now();

    try {
      if (!this.printerService.isOnline(request.printerName)) {
        throw new Error(`Printer ${request.printerName} is not available`);
      }

      this.printerService.updateJobCount(request.printerName, 1);

      // Log ultra-optimization attempt
      const copies = request.metadata.copies || 1;
      logger.debug(`🚀 Processing ultra-optimized job: ${copies} copies to ${request.printerName}`);

      await this.printerService.printLabel(
        request.printerName,
        request.htmlContent,
        request.metadata
      );

      this.queueService.completeJob(job.id, true);
      const processingTime: number = Date.now() - startTime;
      
      // Update both regular and ultra-optimization metrics
      this.updateProcessingTime(processingTime);
      this.updateUltraOptimizationMetrics(processingTime, copies);

      // Log performance achievement
      const avgTimePerCopy = processingTime / copies;
      if (avgTimePerCopy < 100) {
        logger.info(`⚡ ULTRA-FAST: ${copies} copies in ${processingTime}ms (${avgTimePerCopy.toFixed(0)}ms/copy)`);
      }

    } catch (error: any) {
      logger.error(`Job ${job.id} failed:`, error);
      this.queueService.completeJob(job.id, false, error.message);
      
      // Track fallback usage
      if (error.message?.includes('PUPPETEER FAILED')) {
        this.ultraOptimizationMetrics.puppeteerFallbackCount++;
      } else if (error.message?.includes('wkhtmltopdf')) {
        this.ultraOptimizationMetrics.wkhtmltopdfFallbackCount++;
      }
    } finally {
      this.printerService.updateJobCount(request.printerName, -1);
    }
  }

  private updateProcessingTime(processingTime: number): void {
    const currentAvg: number = this.metrics.averageProcessingTime;
    const currentCount: number = this.metrics.completedJobs;

    if (currentCount === 0) {
      this.metrics.averageProcessingTime = processingTime;
    } else {
      this.metrics.averageProcessingTime =
        (currentAvg * (currentCount - 1) + processingTime) / currentCount;
    }
  }

  private updateUltraOptimizationMetrics(processingTime: number, copies: number): void {
    this.ultraOptimizationMetrics.totalUltraOptimizedJobs++;
    
    const currentAvg = this.ultraOptimizationMetrics.averageUltraOptimizedTime;
    const currentCount = this.ultraOptimizationMetrics.totalUltraOptimizedJobs;
    
    if (currentCount === 1) {
      this.ultraOptimizationMetrics.averageUltraOptimizedTime = processingTime;
    } else {
      this.ultraOptimizationMetrics.averageUltraOptimizedTime =
        (currentAvg * (currentCount - 1) + processingTime) / currentCount;
    }
    
    this.ultraOptimizationMetrics.lastOptimizationCheck = Date.now();
  }

  private updateMetrics(): void {
    const queueStatus: QueueStatus = this.queueService.getQueueStatus();
    this.metrics.queueLength = queueStatus.queued;
    this.metrics.totalJobs = queueStatus.queued + queueStatus.processing +
      queueStatus.completed + queueStatus.failed;

    const printers: PrinterStatus[] = this.printerService.getAllPrinters();
    this.metrics.activePrinters = printers.filter((p: PrinterStatus): boolean =>
      p.status === 'online'
    ).length;
  }

  public submitPrintJob(request: PrintRequest): string {
    this.metrics.totalJobs++;
    
    // Log submission with ultra-optimization context
    const copies = request.metadata.copies || 1;
    logger.debug(`📋 Job submitted: ${copies} copies to ${request.printerName} (Priority: ${request.metadata.priority})`);
    
    return this.queueService.addJob(request);
  }

  public getJobStatus(jobId: string): PrintJob | undefined {
    return this.queueService.getJob(jobId);
  }

  public getMetrics(): ServerMetrics {
    return { ...this.metrics };
  }

  public getPrinterStatus(): PrinterStatus[] {
    return this.printerService.getAllPrinters();
  }

  // NEW: Ultra-optimization specific methods
  public getBrowserStatus(): { available: boolean, error?: string, stats?: any } {
    if (typeof this.printerService.getBrowserStatus === 'function') {
      return this.printerService.getBrowserStatus();
    }
    return { available: false, error: 'getBrowserStatus method not available on PrinterService' };
  }

  public getPerformanceStats(): any {
    const browserStatus = this.getBrowserStatus();
    
    return {
      // Browser and Puppeteer stats
      browser: browserStatus,
      
      // Ultra-optimization metrics
      ultraOptimization: {
        ...this.ultraOptimizationMetrics,
        averageTimePerJob: this.ultraOptimizationMetrics.averageUltraOptimizedTime,
        optimizationSuccessRate: this.ultraOptimizationMetrics.totalUltraOptimizedJobs > 0 
          ? ((this.ultraOptimizationMetrics.totalUltraOptimizedJobs - this.ultraOptimizationMetrics.puppeteerFallbackCount - this.ultraOptimizationMetrics.wkhtmltopdfFallbackCount) / this.ultraOptimizationMetrics.totalUltraOptimizedJobs * 100).toFixed(1) + '%'
          : '0%'
      },
      
      // System performance
      system: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        activeTimers: this.getActiveHandlesCount(),
        timestamp: new Date().toISOString()
      },
      
      // Queue performance
      queue: this.queueService.getQueueStatus(),
      
      // Printer performance  
      printers: {
        total: this.printerService.getAllPrinters().length,
        online: this.printerService.getAllPrinters().filter(p => p.status === 'online').length,
        withJobs: this.printerService.getAllPrinters().filter(p => p.jobsInQueue > 0).length
      }
    };
  }

  public getUltraOptimizationReport(): any {
    const stats = this.getPerformanceStats();
    const avgTime = this.ultraOptimizationMetrics.averageUltraOptimizedTime;
    
    return {
      status: avgTime < 500 ? 'EXCELLENT' : avgTime < 1000 ? 'GOOD' : avgTime < 2000 ? 'NEEDS_IMPROVEMENT' : 'POOR',
      performance: {
        averageJobTime: avgTime,
        totalOptimizedJobs: this.ultraOptimizationMetrics.totalUltraOptimizedJobs,
        successRate: stats.ultraOptimization.optimizationSuccessRate,
        fallbacks: {
          puppeteer: this.ultraOptimizationMetrics.puppeteerFallbackCount,
          wkhtmltopdf: this.ultraOptimizationMetrics.wkhtmltopdfFallbackCount
        }
      },
      recommendations: this.generateOptimizationRecommendations(avgTime),
      browserHealth: stats.browser,
      lastCheck: new Date(this.ultraOptimizationMetrics.lastOptimizationCheck).toISOString()
    };
  }

  private generateOptimizationRecommendations(avgTime: number): string[] {
    const recommendations: string[] = [];
    
    if (avgTime > 1000) {
      recommendations.push('Consider reducing concurrent jobs in config');
      recommendations.push('Check if browser is experiencing memory pressure');
    }
    
    if (this.ultraOptimizationMetrics.puppeteerFallbackCount > 0) {
      recommendations.push('Monitor Puppeteer stability - fallbacks detected');
    }
    
    if (this.ultraOptimizationMetrics.wkhtmltopdfFallbackCount > 0) {
      recommendations.push('wkhtmltopdf fallbacks detected - check Puppeteer configuration');
    }
    
    const browserStatus = this.getBrowserStatus();
    if (!browserStatus.available) {
      recommendations.push('Browser not available - check Puppeteer initialization');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('Ultra-optimization performing excellently!');
    }
    
    return recommendations;
  }

  // Helper method to safely get active handles count
  private getActiveHandlesCount(): number | string {
    try {
      // Type assertion to access private method safely
      const processWithPrivate = process as any;
      if (typeof processWithPrivate._getActiveHandles === 'function') {
        return processWithPrivate._getActiveHandles().length;
      }
      return 'unavailable';
    } catch (error) {
      return 'error';
    }
  }

  // Enhanced test method with ultra-optimization awareness
  public async testPrint(printerName: string, copies: number = 1): Promise<boolean> {
    if (typeof this.printerService.testPrint === 'function') {
      const startTime = Date.now();
      
      try {
        const result = await this.printerService.testPrint(printerName);
        const duration = Date.now() - startTime;
        
        logger.info(`🧪 Test print completed in ${duration}ms (Expected: <500ms for ultra-optimization)`);
        
        return result;
      } catch (error) {
        logger.error('Test print failed:', error);
        return false;
      }
    }
    
    logger.warn('testPrint method not available on PrinterService');
    return false;
  }

  public async resetZebraMediaValues(printerName: string): Promise<boolean> {
    return await this.printerService.resetZebraMediaValues(printerName);
  }

  public destroy(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    this.printerService.destroy();
    
    // Reset singleton state
    PrintService.isInitialized = false;
    
    logger.info('🧹 PrintService singleton destroyed and reset');
  }
}