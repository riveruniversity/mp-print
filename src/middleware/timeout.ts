// src/middleware/timeout.ts - Global timeout middleware

import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export const globalTimeoutMiddleware = (timeoutMs: number = 30000) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Set response timeout
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        logger.warn(`Request timeout for ${req.method} ${req.path} after ${timeoutMs}ms`);
        res.status(504).json({
          success: false,
          error: 'Request timeout',
          message: `Request timed out after ${timeoutMs}ms`,
          path: req.path,
          method: req.method
        });
      }
    });

    // Also set request timeout
    req.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        logger.warn(`Request timeout for ${req.method} ${req.path} - request side timeout`);
        res.status(408).json({
          success: false,
          error: 'Request timeout',
          message: 'Request processing timed out'
        });
      }
    });

    next();
  };
};

// Specific timeout for print routes
export const printRouteTimeout = (timeoutMs: number = 15000) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setTimeout(timeoutMs, () => {
      if (!res.headersSent) {
        logger.warn(`Print route timeout for ${req.method} ${req.path} after ${timeoutMs}ms`);
        res.status(504).json({
          success: false,
          error: 'Print operation timeout',
          message: `Print operation timed out after ${timeoutMs}ms`,
          path: req.path
        });
      }
    });
    next();
  };
};