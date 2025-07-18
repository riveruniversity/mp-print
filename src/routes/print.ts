// src/routes/print.ts - Ultra-optimized with singleton and performance monitoring

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PrintService } from '../services/PrintService';
import { validatePrintRequest } from '../middleware/validation';
import { PrintRequest, PrintJob, ServerMetrics, PrinterStatus, ApiResponse } from '../types';

const router: Router = Router();

// Use singleton instance instead of creating new one
let printService: PrintService;

// Initialize function to be called from server.ts
export const initializePrintService = async (): Promise<void> => {
  printService = PrintService.getInstance();
  await printService.initialize();
};

// Get the service instance with error handling
const getPrintService = (): PrintService => {
  if (!printService) {
    throw new Error('PrintService not initialized. Call initializePrintService() first.');
  }
  return printService;
};

// Enhanced submit endpoint with ultra-optimization awareness
router.post('/submit', validatePrintRequest, async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  
  try {
    const service = getPrintService();
    
    const request: PrintRequest = {
      id: uuidv4(),
      printerName: req.body.printerName,
      htmlContent: req.body.htmlContent,
      metadata: req.body.metadata,
      timestamp: Date.now(),
      retryCount: 0
    };

    // Log request details for ultra-optimization monitoring
    console.log(`🎯 PRINT REQUEST: ${request.metadata.copies} copies to ${request.printerName}`);

    const jobId: string = service.submitPrintJob(request);
    
    const processingTime = Date.now() - startTime;
    
    const response: ApiResponse<{ jobId: string; processingTime: number }> = {
      success: true,
      data: { 
        jobId,
        processingTime  // Include timing for performance monitoring
      },
      message: 'Print job submitted successfully'
    };
    
    res.json(response);
  } catch (error: any) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ SUBMIT FAILED in ${processingTime}ms:`, error.message);
    
    const response: ApiResponse = {
      success: false,
      error: error.message
    };
    res.status(500).json(response);
  }
});

router.get('/status/:jobId', (req: Request, res: Response): void => {
  try {
    const service = getPrintService();
    const job: PrintJob | undefined = service.getJobStatus(req.params.jobId);
    
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
  } catch (error: any) {
    const response: ApiResponse = {
      success: false,
      error: error.message
    };
    res.status(500).json(response);
  }
});

// Enhanced metrics with ultra-optimization stats
router.get('/metrics', (req: Request, res: Response): void => {
  try {
    const service = getPrintService();
    const metrics: ServerMetrics = service.getMetrics();
    
    // Add ultra-optimization performance stats if available
    let ultraStats = {};
    if (typeof service.getPerformanceStats === 'function') {
      ultraStats = service.getPerformanceStats();
    }
    
    const response: ApiResponse<{ 
      metrics: ServerMetrics; 
      ultraOptimization?: any;
      timestamp: string;
    }> = {
      success: true,
      data: { 
        metrics,
        ultraOptimization: ultraStats,
        timestamp: new Date().toISOString()
      }
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

router.get('/printers', (req: Request, res: Response): void => {
  try {
    const service = getPrintService();
    const printers: PrinterStatus[] = service.getPrinterStatus();
    
    const response: ApiResponse<{ 
      printers: PrinterStatus[];
      totalPrinters: number;
      onlinePrinters: number;
    }> = {
      success: true,
      data: { 
        printers,
        totalPrinters: printers.length,
        onlinePrinters: printers.filter(p => p.status === 'online').length
      }
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

// New endpoint for ultra-optimization browser status
router.get('/browser-status', (req: Request, res: Response): void => {
  try {
    const service = getPrintService();
    
    // Check if the ultra-optimized browser status method exists
    let browserStatus: { available: boolean; error?: string; stats?: any } = { 
      available: false, 
      error: 'Method not available' 
    };
    
    if (typeof service.getBrowserStatus === 'function') {
      browserStatus = service.getBrowserStatus();
    }
    
    const response: ApiResponse<{ browserStatus: any }> = {
      success: true,
      data: { browserStatus }
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

// Performance test endpoint for ultra-optimization validation
router.post('/test-performance/:printerName', async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  
  try {
    const printerName: string = req.params.printerName;
    const copies: number = parseInt(req.body.copies || '3');
    
    const service = getPrintService();
    
    // Check if printer exists and is online
    const printer: PrinterStatus | undefined = service.getPrinterStatus().find(p => p.name === printerName);
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

    // Create test HTML optimized for ultra-fast processing
    const testHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @page { margin: 0; size: 10in 1in; }
          body { margin: 0; padding: 5px; font-family: Arial; font-size: 12px; }
        </style>
      </head>
      <body>
        <div>⚡ ULTRA-OPTIMIZATION TEST - ${copies} copies - ${new Date().toLocaleString()}</div>
      </body>
      </html>
    `;

    const base64Html = Buffer.from(testHtml).toString('base64');
    
    const request: PrintRequest = {
      id: uuidv4(),
      printerName,
      htmlContent: base64Html,
      metadata: {
        ageGroup: 'test',
        priority: 'high',
        copies
      },
      timestamp: Date.now(),
      retryCount: 0
    };

    console.log(`🧪 PERFORMANCE TEST: ${copies} copies to ${printerName}`);
    
    const jobId: string = service.submitPrintJob(request);
    const totalTime = Date.now() - startTime;
    
    const response: ApiResponse<{ 
      jobId: string;
      testResults: {
        copies: number;
        totalTimeMs: number;
        averagePerCopyMs: number;
        expectedUltraOptimized: boolean;
      }
    }> = {
      success: true,
      data: { 
        jobId,
        testResults: {
          copies,
          totalTimeMs: totalTime,
          averagePerCopyMs: Math.round(totalTime / copies),
          expectedUltraOptimized: totalTime < (copies === 1 ? 500 : 700)
        }
      },
      message: `Performance test submitted: ${copies} copies in ${totalTime}ms`
    };
    
    res.json(response);
  } catch (error: any) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ PERFORMANCE TEST FAILED in ${totalTime}ms:`, error.message);
    
    const response: ApiResponse = {
      success: false,
      error: error.message
    };
    res.status(500).json(response);
  }
});

// Enhanced Zebra reset endpoint
router.post('/zebra/reset-media/:printerName', async (req: Request, res: Response): Promise<void> => {
  try {
    const printerName: string = req.params.printerName;
    const service = getPrintService();
    
    // Check if printer exists and is online
    const printer: PrinterStatus | undefined = service.getPrinterStatus().find(p => p.name === printerName);
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

    console.log(`🔧 ZEBRA RESET: ${printerName}`);
    
    // Send ZPL commands to reset media values
    const success: boolean = await service.resetZebraMediaValues(printerName);
    
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