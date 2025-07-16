import { PrinterService } from './PrinterService';
import { QueueService } from './QueueService';
import { PrintRequest, ServerMetrics, PrintJob, QueueStatus, PrinterStatus } from '../types';
import { config } from '../config';
import logger from '../utils/logger';

export class PrintService {
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

  constructor() {
    this.printerService = new PrinterService();
    this.queueService = new QueueService();
    this.setupEventListeners();
  }

  public async initialize(): Promise<void> {
    await this.printerService.initialize();
    this.startProcessing();
    this.startMetricsCollection();
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
    }, 1000); // Process every second
  }

  private startMetricsCollection(): void {
    this.metricsInterval = setInterval((): void => {
      this.updateMetrics();
    }, 5000); // Update metrics every 5 seconds
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
      // Check if printer is available
      if (!this.printerService.isOnline(request.printerName)) {
        throw new Error(`Printer ${request.printerName} is not available`);
      }

      // Update printer job count
      this.printerService.updateJobCount(request.printerName, 1);

      // Process the print job
      await this.printerService.printLabel(
        request.printerName,
        request.htmlContent,
        request.metadata
      );

      // Complete the job
      this.queueService.completeJob(job.id, true);

      // Update metrics
      const processingTime: number = Date.now() - startTime;
      this.updateProcessingTime(processingTime);

    } catch (error: any) {
      logger.error(`Job ${job.id} failed:`, error);
      this.queueService.completeJob(job.id, false, error.message);
    } finally {
      // Update printer job count
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
  }
}