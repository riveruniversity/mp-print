import dotenv from 'dotenv';
import { parseNumber, parseBoolean, parseArray } from '../utils/parser';

dotenv.config();

export const config = {
  server: {
    port: parseNumber(process.env.PORT, 3000),
    host: process.env.HOST || '0.0.0.0',
    workers: parseNumber(process.env.WORKERS, 4),
    maxRequestSize: process.env.MAX_REQUEST_SIZE || '50mb',
    timeout: parseNumber(process.env.SERVER_TIMEOUT, 30000),
    keepAliveTimeout: parseNumber(process.env.KEEP_ALIVE_TIMEOUT, 5000)
  },
  security: {
    allowedOrigins: parseArray(process.env.ALLOWED_ORIGINS, ['http://localhost:3000', 'http://localhost:8080']),
    rateLimitWindowMs: parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 900000), // 15 minutes
    rateLimitMax: parseNumber(process.env.RATE_LIMIT_MAX, 1000)
  },
  printing: {
    maxQueueSize: parseNumber(process.env.MAX_QUEUE_SIZE, 10000),
    maxRetries: parseNumber(process.env.MAX_RETRIES, 3),
    retryDelay: parseNumber(process.env.RETRY_DELAY, 2000),
    processingTimeout: parseNumber(process.env.PROCESSING_TIMEOUT, 30000),
    batchSize: parseNumber(process.env.BATCH_SIZE, 10),
    maxConcurrentJobs: parseNumber(process.env.MAX_CONCURRENT_JOBS, 50),
    printerHealthCheckInterval: parseNumber(process.env.PRINTER_HEALTH_CHECK_INTERVAL, 30000),
    ieTimeout: parseNumber(process.env.IE_PRINT_TIMEOUT, 10000),
    puppeteerPagePoolSize: parseNumber(process.env.PUPPETEER_PAGE_POOL_SIZE, 5),
    puppeteerBrowserHealthInterval: parseNumber(process.env.PUPPETEER_HEALTH_INTERVAL, 30000),
    puppeteerMaxPages: parseNumber(process.env.PUPPETEER_MAX_PAGES, 20),
    puppeteerBatchSize: parseNumber(process.env.PUPPETEER_BATCH_SIZE, 5)
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    maxFiles: parseNumber(process.env.LOG_MAX_FILES, 5),
    maxSize: process.env.LOG_MAX_SIZE || '20m'
  },
  service: {
    name: process.env.SERVICE_NAME || 'PrintServer',
    displayName: process.env.SERVICE_DISPLAY_NAME || 'High Performance Print Server',
    description: process.env.SERVICE_DESCRIPTION || 'Node.js print server for label printing with TypeScript',
    path: process.env.SERVICE_PATH || 'C:\\PrintServer',
    nodePath: process.env.NODE_PATH || 'C:\\Program Files\\nodejs\\node.exe'
  },
  monitoring: {
    healthCheckInterval: parseNumber(process.env.HEALTH_CHECK_INTERVAL, 60000),
    metricsUpdateInterval: parseNumber(process.env.METRICS_UPDATE_INTERVAL, 5000),
    cleanupInterval: parseNumber(process.env.CLEANUP_INTERVAL, 300000)
  },
  windows: {
    printerDiscoveryInterval: parseNumber(process.env.PRINTER_DISCOVERY_INTERVAL, 60000),
    tempFileCleanupInterval: parseNumber(process.env.TEMP_FILE_CLEANUP_INTERVAL, 300000)
  }
};