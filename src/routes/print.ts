import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PrintService } from '../services/PrintService';
import { validatePrintRequest } from '../middleware/validation';
import { PrintRequest, PrintJob, ServerMetrics, PrinterStatus, ApiResponse } from '../types';

const router: Router = Router();
const printService: PrintService = new PrintService();

// Initialize print service
printService.initialize().catch((error: Error): void => {
  console.error('Failed to initialize print service:', error);
});

router.post('/submit', validatePrintRequest, async (req: Request, res: Response): Promise<void> => {
  try {
    const request: PrintRequest = {
      id: uuidv4(),
      printerName: req.body.printerName,
      htmlContent: req.body.htmlContent,
      metadata: req.body.metadata,
      timestamp: Date.now(),
      retryCount: 0
    };

    const jobId: string = printService.submitPrintJob(request);
    
    const response: ApiResponse<{ jobId: string }> = {
      success: true,
      data: { jobId },
      message: 'Print job submitted successfully'
    };
    
    res.json(response);
  } catch (error: any) {
    const response: ApiResponse = {
      success: false,
      error: error.message
    };
    res.status(500).json(response);
  }
});

router.get('/status/:jobId', (req: Request, res: Response): void => {
  const job: PrintJob | undefined = printService.getJobStatus(req.params.jobId);
  if (!job) {
    const response: ApiResponse = {
      success: false,
      error: 'Job not found'
    };
    res.status(404).json(response);
    return;
  }
  
  const response: ApiResponse<{ job: PrintJob }> = {
    success: true,
    data: { job }
  };
  res.json(response);
});

router.get('/metrics', (req: Request, res: Response): void => {
  const metrics: ServerMetrics = printService.getMetrics();
  const response: ApiResponse<{ metrics: ServerMetrics }> = {
    success: true,
    data: { metrics }
  };
  res.json(response);
});

router.get('/printers', (req: Request, res: Response): void => {
  const printers: PrinterStatus[] = printService.getPrinterStatus();
  const response: ApiResponse<{ printers: PrinterStatus[] }> = {
    success: true,
    data: { printers }
  };
  res.json(response);
});

// New endpoint to reset Zebra printer media values
router.post('/zebra/reset-media/:printerName', async (req: Request, res: Response): Promise<void> => {
  try {
    const printerName: string = req.params.printerName;
    
    // Check if printer exists and is online
    const printer: PrinterStatus | undefined = printService.getPrinterStatus().find(p => p.name === printerName);
    if (!printer) {
      const response: ApiResponse = {
        success: false,
        error: 'Printer not found'
      };
      res.status(404).json(response);
      return;
    }

    if (printer.status !== 'online') {
      const response: ApiResponse = {
        success: false,
        error: 'Printer is not online'
      };
      res.status(400).json(response);
      return;
    }

    // Send ZPL commands to reset media values
    const success: boolean = await printService.resetZebraMediaValues(printerName);
    
    if (success) {
      const response: ApiResponse<{ message: string }> = {
        success: true,
        data: { message: 'Media values reset successfully' },
        message: 'Zebra printer media values have been reset'
      };
      res.json(response);
    } else {
      const response: ApiResponse = {
        success: false,
        error: 'Failed to reset media values'
      };
      res.status(500).json(response);
    }
  } catch (error: any) {
    const response: ApiResponse = {
      success: false,
      error: error.message
    };
    res.status(500).json(response);
  }
});

export default router;