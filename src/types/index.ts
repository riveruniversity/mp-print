export interface PrintRequest {
  id: string;
  labels: PrintLabel[];
  metadata: PrintMetadata;
  timestamp: number;
  retryCount: number;
}

export interface PrintLabel {
  userId: number;
  name: string;
  htmlContent: string; // base64 encoded HTML
  printerName: string;
  printMedia: PrintMedia;
  mpGroup: MPGroup;
  margin: { top: string, right: string, bottom: string, left: string; },
  width: string;
  height: string;
  copies: number;
  orientation?: PrintOrientation;
}

export interface PrintMetadata {
  priority?: PrintPriority;
  copies?: number;
  paperSize?: string;
}


interface MPGroup {
  id: number;
  name: 'Minors' | 'Adults' | 'Youth' | 'Kids' | 'Bears' | 'Nursery';
  print: 'Label' | 'Wristband';
}


export type PrintMedia = 'Wristband' | 'Label';
export type PrintPriority = 'low' | 'medium' | 'high';
export type PrintOrientation = 'portrait' | 'landscape';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type PrinterStatusType = 'online' | 'offline' | 'busy' | 'error';

export interface PrintJob {
  id: string;
  status: JobStatus;
  request: PrintRequest;
  startTime?: number;
  endTime?: number;
  error?: string;
}

export interface PrinterStatus {
  name: string;
  port: string;
  driver: string;
  status: PrinterStatusType;
  jobsInQueue: number;
  lastJobTime?: number;
  errorCount: number;
}

export interface ServerMetrics {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  averageProcessingTime: number;
  queueLength: number;
  activePrinters: number;
}

export interface QueueStatus {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
}

export interface ServerConfig {
  server: {
    port: number;
    host: string;
    maxRequestSize: string;
    timeout: number;
    workers: number;
    keepAliveTimeout: number;
  };
  printing: {
    maxQueueSize: number;
    maxRetries: number;
    retryDelay: number;
    processingTimeout: number;
    batchSize: number;
    maxConcurrentJobs: number;
    printerHealthCheckInterval: number;
    printerDiscoveryInterval: number;
    tempFileCleanupInterval: number;
    iePrintTimeout: number;
  };
  security: {
    rateLimitWindowMs: number;
    rateLimitMax: number;
    allowedOrigins: string[];
    enableCors: boolean;
    enableHelmet: boolean;
    enableRateLimiting: boolean;
  };
  logging: {
    level: string;
    maxFiles: number;
    maxSize: string;
  };
  monitoring: {
    healthCheckInterval: number;
    metricsUpdateInterval: number;
    cleanupInterval: number;
  };
  service: {
    name: string;
    displayName: string;
    description: string;
    path: string;
    nodePath: string;
  };
  development: {
    enableCompression: boolean;
  };
}

export interface WindowsPrinter {
  PrinterStatus: number;
  Name: string;
  DriverName: string;
  PortName: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface HealthCheckResponse {
  status: string;
  timestamp: string;
  uptime: number;
  memory: NodeJS.MemoryUsage;
}

export interface FailedLabel {
  userId: string;
  name: string;
  error: string;
  printerName: string;
}

export interface SubmitResponse {
  jobIds: string[];
  totalLabels: number;
  processingTime: number;
}

export interface PartialSuccessResponse {
  successfulJobs: string[];
  failedLabels: FailedLabel[];
  totalLabels: number;
  processingTime: number;
}

export interface AllFailedResponse {
  failedLabels: FailedLabel[];
  totalLabels: number;
  processingTime: number;
}