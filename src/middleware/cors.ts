import { Request, Response, NextFunction } from 'express';
import { config } from '../config';



export const corsConfig = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const allowedOrigins = config.security.allowedOrigins;

    if (allowedOrigins.includes(origin || '') || !origin) {
      res.header('Access-Control-Allow-Origin', origin || '*');
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Forwarded-For');
    res.header('Access-Control-Allow-Credentials', 'true');

    if (req.headers['access-control-request-private-network']) {
      res.header('Access-Control-Allow-Private-Network', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  }