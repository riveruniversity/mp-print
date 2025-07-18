import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import cluster, { type Worker } from 'cluster';

import { config } from './config';
import logger from './utils/logger';
import printRoutes from './routes/print';
import { PrintService } from './services/PrintService';
import { HealthCheckResponse } from './types';

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
  let printService: PrintService;

  // trust the entire private network:
  app.set('trust proxy', ['loopback', '10.0.0.0/8', '127.0.0.1', '::1']);

  // Security middleware
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false
  }));

  // app.use(cors({
  //   origin: config.security.allowedOrigins,
  //   credentials: true,

  //   // Access from checkin suite
  //   preflightContinue: false,
  //   optionsSuccessStatus: 200
  // }));

  // middleware to handle private network requests
  app.use((req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const allowedOrigins = config.security.allowedOrigins;

    if (allowedOrigins.includes(origin || '') || !origin) {
      res.header('Access-Control-Allow-Origin', origin || '*');
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Forwarded-For');
    res.header('Access-Control-Allow-Credentials', 'true');

    // This is the key header for private network requests
    if (req.headers['access-control-request-private-network']) {
      res.header('Access-Control-Allow-Private-Network', 'true');
    }

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  });



  // Rate limiting
  const limiter = rateLimit({
    windowMs: config.security.rateLimitWindowMs,
    max: config.security.rateLimitMax,
    message: { error: 'Too many requests' }
  });


  // Handle client disconnects gracefully
  app.use((req: Request, res: Response, next: NextFunction): void => {
    // Handle client disconnects gracefully using modern approach
    req.on('close', () => {
      if (req.destroyed) {
        logger.warn(`Request closed/destroyed by client: ${req.method} ${req.path} - ${req.ip}`);
      }
    });

    // Set connection keep-alive
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
      // Don't try to send a response if the connection is already closed
      return;
    }

    logger.error('Unhandled error:', err);

    // Only send response if connection is still open
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

    // Initialize print service
    try {
      printService = new PrintService();
      await printService.initialize();
      logger.info('Print service initialized successfully');
    } catch (error: any) {
      logger.error('Failed to initialize print service:', error);
      process.exit(1);
    }
  });

  // Set server timeout
  server.timeout = config.server.timeout;

  // Graceful shutdown handlers
  const gracefulShutdown = (signal: string): void => {
    logger.info(`${signal} received, shutting down gracefully`);
    server.close((): void => {
      if (printService) {
        printService.destroy();
      }
      logger.info('Server shut down complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', (): void => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', (): void => gracefulShutdown('SIGINT'));

  // Handle uncaught exceptions
  process.on('uncaughtException', (error: Error): void => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any, promise: Promise<any>): void => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
}