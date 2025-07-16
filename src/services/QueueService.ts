import { EventEmitter } from 'events';
import { PrintRequest, PrintJob, QueueStatus, PrintPriority } from '../types';
import { config } from '../config';
import logger from '../utils/logger';

export class QueueService extends EventEmitter {
  private queue: Map<string, PrintJob> = new Map();
  private processingQueue: Set<string> = new Set();
  private completedJobs: Map<string, PrintJob> = new Map();
  private failedJobs: Map<string, PrintJob> = new Map();

  public addJob(request: PrintRequest): string {
    if (this.queue.size >= config.printing.maxQueueSize) {
      throw new Error('Queue is full');
    }

    const job: PrintJob = {
      id: request.id,
      status: 'queued',
      request
    };

    this.queue.set(request.id, job);
    this.emit('jobAdded', job);
    
    logger.info(`Job ${request.id} added to queue`);
    return request.id;
  }

  public getNextJobs(batchSize: number = config.printing.batchSize): PrintJob[] {
    const availableJobs: PrintJob[] = Array.from(this.queue.values())
      .filter((job: PrintJob): boolean => !this.processingQueue.has(job.id))
      .sort((a: PrintJob, b: PrintJob): number => {
        // Priority sorting: high > medium > low, then by timestamp
        const priorityOrder: Record<PrintPriority, number> = { high: 3, medium: 2, low: 1 };
        const aPriority: number = priorityOrder[a.request.metadata.priority];
        const bPriority: number = priorityOrder[b.request.metadata.priority];
        
        if (aPriority !== bPriority) {
          return bPriority - aPriority;
        }
        return a.request.timestamp - b.request.timestamp;
      });

    const batch: PrintJob[] = availableJobs.slice(0, batchSize);
    
    // Mark as processing
    batch.forEach((job: PrintJob): void => {
      this.processingQueue.add(job.id);
      job.status = 'processing';
      job.startTime = Date.now();
    });

    return batch;
  }

  public completeJob(jobId: string, success: boolean, error?: string): void {
    const job: PrintJob | undefined = this.queue.get(jobId);
    if (!job) return;

    job.endTime = Date.now();
    job.status = success ? 'completed' : 'failed';
    if (error) job.error = error;

    this.processingQueue.delete(jobId);
    this.queue.delete(jobId);

    if (success) {
      this.completedJobs.set(jobId, job);
      this.emit('jobCompleted', job);
    } else {
      // Retry logic
      if (job.request.retryCount < config.printing.maxRetries) {
        job.request.retryCount++;
        job.status = 'queued';
        
        setTimeout((): void => {
          this.queue.set(jobId, job);
          this.emit('jobRetry', job);
        }, config.printing.retryDelay * job.request.retryCount);
      } else {
        this.failedJobs.set(jobId, job);
        this.emit('jobFailed', job);
      }
    }

    logger.info(`Job ${jobId} ${success ? 'completed' : 'failed'}`);
  }

  public getJob(jobId: string): PrintJob | undefined {
    return this.queue.get(jobId) || 
           this.completedJobs.get(jobId) || 
           this.failedJobs.get(jobId);
  }

  public getQueueStatus(): QueueStatus {
    return {
      queued: this.queue.size - this.processingQueue.size,
      processing: this.processingQueue.size,
      completed: this.completedJobs.size,
      failed: this.failedJobs.size
    };
  }

  public cleanup(): void {
    // Clean up old completed jobs (keep last 1000)
    if (this.completedJobs.size > 1000) {
      const sorted: [string, PrintJob][] = Array.from(this.completedJobs.entries())
        .sort(([, a]: [string, PrintJob], [, b]: [string, PrintJob]): number => 
          (b.endTime || 0) - (a.endTime || 0)
        );
      
      const toDelete: [string, PrintJob][] = sorted.slice(1000);
      toDelete.forEach(([id]: [string, PrintJob]): void => {
        this.completedJobs.delete(id);
      });
    }

    // Clean up old failed jobs (keep last 500)
    if (this.failedJobs.size > 500) {
      const sorted: [string, PrintJob][] = Array.from(this.failedJobs.entries())
        .sort(([, a]: [string, PrintJob], [, b]: [string, PrintJob]): number => 
          (b.endTime || 0) - (a.endTime || 0)
        );
      
      const toDelete: [string, PrintJob][] = sorted.slice(500);
      toDelete.forEach(([id]: [string, PrintJob]): void => {
        this.failedJobs.delete(id);
      });
    }
  }
}