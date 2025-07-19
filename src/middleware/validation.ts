import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';
import { PrintRequest } from '../types';

const printRequestSchema: Joi.ObjectSchema = Joi.object({
  labels: Joi.array().items(
    Joi.object({
      userId: Joi.number().integer().optional(),
      name: Joi.string().optional(),
      htmlContent: Joi.string().base64().required(),
      printerName: Joi.string().required(),
      printMedia: Joi.string().valid('Wristband', 'Label').required(),
      margin: Joi.object({
        top: Joi.string().required(),
        right: Joi.string().required(),
        bottom: Joi.string().required(),
        left: Joi.string().required()
      }).required(),
      mpGroup: Joi.object({
        id: Joi.number().integer().required(),
        name: Joi.string().valid('Minors', 'Adults', 'Youth', 'Kids', 'Bears', 'Nursery').required(),
        print: Joi.string().valid('Label', 'Wristband').required()
      }).optional(),
      width: Joi.string().required(),
      height: Joi.string().required(),
      orientation: Joi.string().valid('portrait', 'landscape').optional(),
      copies: Joi.number().integer().min(1).max(10).default(1)
    })
  ).min(1).required(),
  
  metadata: Joi.object({
    priority: Joi.string().valid('low', 'medium', 'high').default('medium')
  }).required()
});

export const validatePrintRequest = (req: Request, res: Response, next: NextFunction): void => {
  const { error }: Joi.ValidationResult = printRequestSchema.validate(req.body);
  if (error) {
    res.status(400).json({
      error: 'Validation error',
      details: error.details.map((d: Joi.ValidationErrorItem): string => d.message)
    });
    return;
  }
  next();
};