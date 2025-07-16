import Joi from 'joi';
import { Request, Response, NextFunction } from 'express';

const printRequestSchema: Joi.ObjectSchema = Joi.object({
  printerName: Joi.string().required(),
  htmlContent: Joi.string().base64().required(),
  metadata: Joi.object({
    ageGroup: Joi.string().required(),
    priority: Joi.string().valid('low', 'medium', 'high').default('medium'),
    copies: Joi.number().integer().min(1).max(10).default(1),
    paperSize: Joi.string().optional(),
    orientation: Joi.string().valid('portrait', 'landscape').optional()
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