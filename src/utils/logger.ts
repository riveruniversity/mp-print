import winston from 'winston';
import { config } from '../config';

const logger: winston.Logger = winston.createLogger({
  level: config.logging.level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'print-server' },
  transports: [
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxFiles: config.logging.maxFiles,
      maxsize: 20 * 1024 * 1024 // 20MB
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxFiles: config.logging.maxFiles,
      maxsize: 20 * 1024 * 1024
    })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

export default logger;