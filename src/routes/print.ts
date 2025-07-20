// src/routes/print.ts - Fixed with proper timeouts and error handling

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PrintService } from '../services/PrintService';
import { validatePrintRequest } from '../middleware/validation';
import { PrintRequest, PrintJob, ServerMetrics, PrinterStatus, ApiResponse } from '../types';
import { FailedLabel, SubmitResponse, PartialSuccessResponse, AllFailedResponse } from '../types';

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

// Timeout wrapper for route handlers
const withTimeout = (handler: (req: Request, res: Response) => Promise<void>, timeoutMs: number = 10000) => {
  return async (req: Request, res: Response): Promise<void> => {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Route timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      await Promise.race([
        handler(req, res),
        timeoutPromise
      ]);
    } catch (error: any) {
      if (!res.headersSent) {
        if (error.message.includes('timeout')) {
          res.status(504).json({
            success: false,
            error: 'Request timeout',
            message: `Operation timed out after ${timeoutMs}ms`
          });
        } else {
          res.status(500).json({
            success: false,
            error: error.message
          });
        }
      }
    }
  };
};

router.post('/submit', validatePrintRequest, withTimeout(async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  
  const service = getPrintService();
  const { labels, metadata } = req.body;
  
  const successfulJobs: string[] = [];
  const failedLabels: FailedLabel[] = [];

  // Process each label separately with improved error isolation and timeout
  const labelProcessingPromises = labels.map(async (label: any) => {
    const labelTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Label processing timeout for ${label.printerName}`)), 5000);
    });

    const labelProcessing = (async () => {
      try {
        // Validate printer is available with timeout
        const printer = service.getPrinterStatus().find(p => p.name === label.printerName);
        if (!printer) {
          failedLabels.push({
            userId: label.userId,
            name: label.name,
            error: `Printer '${label.printerName}' not found`,
            printerName: label.printerName
          });
          return;
        }

        if (printer.status !== 'online') {
          failedLabels.push({
            userId: label.userId,
            name: label.name,
            error: `Printer '${label.printerName}' is ${printer.status}`,
            printerName: label.printerName
          });
          return;
        }

        // Create individual print request
        const request: PrintRequest = {
          id: uuidv4(),
          labels: [label],
          metadata,
          timestamp: Date.now(),
          retryCount: 0
        };

        const jobId = service.submitPrintJob(request);
        successfulJobs.push(jobId);

        console.log(`🎯 LABEL SUBMITTED: ${label.copies} copies of "${label.name}" (userId: ${label.userId}) to ${label.printerName}`);

      } catch (error: any) {
        failedLabels.push({
          userId: label.userId,
          name: label.name,
          error: error.message,
          printerName: label.printerName
        });
      }
    })();

    try {
      await Promise.race([labelProcessing, labelTimeout]);
    } catch (error: any) {
      failedLabels.push({
        userId: label.userId,
        name: label.name,
        error: error.message,
        printerName: label.printerName
      });
    }
  });

  // Wait for all label processing to complete with overall timeout
  await Promise.allSettled(labelProcessingPromises);

  const processingTime = Date.now() - startTime;

  // Response handling
  if (successfulJobs.length > 0 && failedLabels.length === 0) {
    res.json({
      success: true,
      data: { 
        jobIds: successfulJobs,
        totalLabels: labels.length,
        processingTime
      },
      message: `All ${labels.length} labels submitted successfully`
    });
  } else if (successfulJobs.length > 0 && failedLabels.length > 0) {
    res.status(207).json({
      success: false,
      data: {
        successfulJobs,
        failedLabels,
        totalLabels: labels.length,
        processingTime
      },
      message: `${successfulJobs.length}/${labels.length} labels submitted successfully`
    });
  } else {
    res.status(400).json({
      success: false,
      data: {
        failedLabels,
        totalLabels: labels.length,
        processingTime
      },
      error: 'All labels failed validation or printer unavailable'
    });
  }
}, 15000)); // 15 second timeout for submit

router.get('/status/:jobId', withTimeout(async (req: Request, res: Response): Promise<void> => {
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

  const response: ApiResponse<{ job: PrintJob; }> = {
    success: true,
    data: { job }
  };
  res.json(response);
}, 5000)); // 5 second timeout

// Enhanced metrics with performance stats - THIS WAS HANGING
router.get('/metrics', withTimeout(async (req: Request, res: Response): Promise<void> => {
  const service = getPrintService();
  
  // Wrap metrics collection with timeout
  const metricsPromise = new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('Metrics collection timeout')), 3000);
    
    try {
      const metrics: ServerMetrics = service.getMetrics();
      
      // Add performance stats if available
      let performanceStats = {};
      if (typeof service.getPerformanceStats === 'function') {
        performanceStats = service.getPerformanceStats();
      }
      
      resolve({
        metrics,
        performance: performanceStats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      reject(error);
    }
  });

  const data = await metricsPromise;
  
  const response: ApiResponse<any> = {
    success: true,
    data
  };
  res.json(response);
}, 5000)); // 5 second timeout

// THIS WAS THE MAIN PROBLEM - /api/print/printers route hanging
router.get('/printers', withTimeout(async (req: Request, res: Response): Promise<void> => {
  const service = getPrintService();
  
  // Wrap printer status collection with timeout and error handling
  const printersPromise = new Promise<PrinterStatus[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Printer status collection timeout - printer discovery may be hanging'));
    }, 3000); // 3 second timeout
    
    try {
      const printers: PrinterStatus[] = service.getPrinterStatus();
      clearTimeout(timeout);
      resolve(printers);
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });

  try {
    const printers = await printersPromise;
    
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
    // If printer discovery is hanging, return cached/empty data
    console.error('Printer status timeout:', error.message);
    
    const response: ApiResponse<{
      printers: PrinterStatus[];
      totalPrinters: number;
      onlinePrinters: number;
      warning: string;
    }> = {
      success: true,
      data: {
        printers: [], // Return empty array if hanging
        totalPrinters: 0,
        onlinePrinters: 0,
        warning: 'Printer discovery timed out - printer enumeration may be hanging'
      }
    };
    res.json(response);
  }
}, 5000)); // 5 second timeout

// Browser status endpoint
router.get('/browser-status', withTimeout(async (req: Request, res: Response): Promise<void> => {
  const service = getPrintService();

  // Check if the browser status method exists
  let browserStatus: { available: boolean; error?: string; stats?: any; } = {
    available: false,
    error: 'Method not available'
  };

  if (typeof service.getBrowserStatus === 'function') {
    browserStatus = service.getBrowserStatus();
  }

  const response: ApiResponse<{ browserStatus: any; }> = {
    success: true,
    data: { browserStatus }
  };
  res.json(response);
}, 3000)); // 3 second timeout

// Performance test endpoint
router.post('/test-performance/:printerName', withTimeout(async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();

  const printerName: string = req.params.printerName;
  const copies: number = parseInt(req.body.copies || '3');

  const service = getPrintService();

  // Check if printer exists and is online with timeout
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

  // Create test HTML optimized for fast processing
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
      <div>⚡ PRINT TEST - ${copies} copies - ${new Date().toLocaleString()}</div>
    </body>
    </html>
  `;

  const base64Html = Buffer.from(testHtml).toString('base64');

  const request: PrintRequest = {
    id: uuidv4(),
    labels: [
      {
        userId: 12345,
        name: 'Performance Test',
        htmlContent: base64Html,
        printerName: printerName,
        printMedia: 'Label',
        mpGroup: {
          id: 0,
          name: 'Adults',
          print: 'Label'
        },
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
        width: '10in',
        height: '1in',
        copies: copies
      }
    ],
    metadata: {
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
      expectedGoodPerformance: boolean;
    };
  }> = {
    success: true,
    data: {
      jobId,
      testResults: {
        copies,
        totalTimeMs: totalTime,
        averagePerCopyMs: Math.round(totalTime / copies),
        expectedGoodPerformance: totalTime < (copies === 1 ? 500 : 700)
      }
    },
    message: `Performance test submitted: ${copies} copies in ${totalTime}ms`
  };

  res.json(response);
}, 10000)); // 10 second timeout

// Enhanced Zebra reset endpoint
router.post('/zebra/reset-media/:printerName', withTimeout(async (req: Request, res: Response): Promise<void> => {
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
    const response: ApiResponse<{ message: string; }> = {
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
}, 15000)); // 15 second timeout for printer operations

// Performance report endpoint
router.get('/performance-report', withTimeout(async (req: Request, res: Response): Promise<void> => {
  const service = getPrintService();

  let report = {};
  if (typeof service.getPerformanceReport === 'function') {
    report = service.getPerformanceReport();
  }

  const response: ApiResponse<{ report: any; }> = {
    success: true,
    data: { report }
  };
  res.json(response);
}, 5000)); // 5 second timeout

export default router;