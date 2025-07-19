import express, { Application, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import cluster, { type Worker } from 'cluster';

import { config } from './config';
import logger from './utils/logger';
import printRoutes, { initializePrintService } from './routes/print';
import { HealthCheckResponse } from './types';
import { corsConfig } from './middleware/cors';

if (cluster.isPrimary && process.env.NODE_ENV === 'production') {
  const numWorkers: number = config.server.workers;
  logger.info(`Starting ${numWorkers} workers`);

  for (let i: number = 0; i < numWorkers; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker: Worker, code: number, signal: string): void => {
    logger.warn(`Worker ${worker.process.pid} died with code ${code} and signal ${signal}`);
    cluster.fork();
  });
} else {
  const app: Application = express();

  // trust the entire private network:
  app.set('trust proxy', ['loopback', '10.0.0.0/8', '127.0.0.1', '::1']);

  // Security middleware
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false
  }));

  // CORS middleware
  app.use(corsConfig);

  // Rate limiting
  const limiter = rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMax,
    message: { error: 'Too many requests' }
  });

  // Handle client disconnects gracefully
  app.use((req: Request, res: Response, next: NextFunction): void => {
    req.on('close', () => {
      if (req.destroyed) {
        logger.debug(`Client disconnected: ${req.method} ${req.path} - ${req.ip}`);
      }
    });

    res.set('Connection', 'keep-alive');
    next();
  });

  app.use('/api/', limiter);

  // Body parsing and compression
  app.use(compression());
  app.use(express.json({ limit: config.server.maxRequestSize }));
  app.use(express.urlencoded({ extended: true, limit: config.server.maxRequestSize }));

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction): void => {
    logger.info(`${req.method} ${req.path} - ${req.ip}`);
    next();
  });

  // Routes
  app.use('/api/print', printRoutes);

  // Health check endpoint
  app.get('/health', (req: Request, res: Response): void => {
    const healthResponse: HealthCheckResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
    res.json(healthResponse);
  });

  // Error handling middleware
  app.use((err: any, req: Request, res: Response, next: NextFunction): void => {
    if (err.code === 'ECONNABORTED' || err.type === 'request.aborted') {
      logger.warn(`Client disconnected: ${req.method} ${req.path} - ${req.ip}`, {
        error: err.message,
        userAgent: req.get('User-Agent')
      });
      return;
    }

    logger.error('Unhandled error:', err);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  });

  // 404 handler
  app.use('*', (req: Request, res: Response): void => {
    res.status(404).json({
      success: false,
      error: 'Route not found'
    });
  });

  // Start server
  const server = app.listen(config.server.port, config.server.host, async (): Promise<void> => {
    logger.info(`🗄️  Print server running on ${config.server.host}:${config.server.port}`);

    // Initialize print service ONCE using singleton
    try {
      logger.info('Initializing print service singleton...');
      await initializePrintService();
      logger.info('✅ Print service initialized successfully');
    } catch (error: any) {
      logger.error('❌ Failed to initialize print service:', error);
      process.exit(1);
    }
  });

  // Set server timeout
  server.timeout = config.server.timeout;

  // Graceful shutdown handlers
  const gracefulShutdown = (signal: string): void => {
    logger.info(`${signal} received, shutting down gracefully`);
    server.close((): void => {
      // Use singleton instance for cleanup
      try {
        const PrintService = require('./services/PrintService').PrintService;
        const instance = PrintService.getInstance();
        if (instance) {
          instance.destroy();
          logger.info('PrintService singleton destroyed');
        }
      } catch (error) {
        logger.warn('Error during PrintService cleanup:', error);
      }

      logger.info('Server shut down complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', (): void => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', (): void => gracefulShutdown('SIGINT'));

  process.on('uncaughtException', (error: Error): void => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any, promise: Promise<any>): void => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}