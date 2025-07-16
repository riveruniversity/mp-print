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

// Test print endpoint
router.post('/test/:printerName', async (req: Request, res: Response): Promise<void> => {
  try {
    const printerName: string = req.params.printerName;
    
    // Get printer service instance from print service
    const printers: PrinterStatus[] = printService.getPrinterStatus();
    const printer = printers.find(p => p.name === printerName);
    
    if (!printer) {
      const response: ApiResponse = {
        success: false,
        error: `Printer '${printerName}' not found`
      };
      res.status(404).json(response);
      return;
    }

    if (printer.status !== 'online') {
      const response: ApiResponse = {
        success: false,
        error: `Printer '${printerName}' is not online (status: ${printer.status})`
      };
      res.status(400).json(response);
      return;
    }

    // Create test HTML content
    const testHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Print Test</title>
        <style>
          @media print {
            body { 
              margin: 0; 
              padding: 20px; 
              font-family: Arial, sans-serif; 
              font-size: 12pt;
            }
            @page { 
              margin: 10mm; 
              size: auto; 
            }
            * { 
              -webkit-print-color-adjust: exact !important; 
              color-adjust: exact !important; 
            }
          }
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
          }
          .header {
            background-color: #f0f0f0;
            padding: 10px;
            border: 1px solid #ccc;
            margin-bottom: 20px;
          }
          .test-info {
            margin: 10px 0;
          }
          .success {
            color: green;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>🖨️ Print Service Test</h2>
        </div>
        
        <div class="test-info">
          <p><strong>Printer:</strong> ${printerName}</p>
          <p><strong>Test Time:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Server:</strong> ${process.env.COMPUTERNAME || 'Unknown'}</p>
          <p><strong>Print Method:</strong> Microsoft Edge Headless</p>
        </div>
        
        <div class="success">
          ✅ Print service is operational!
        </div>
        
        <p>If you can see this page, the print server successfully:</p>
        <ul>
          <li>Received the print request</li>
          <li>Processed the HTML content</li>
          <li>Found the target printer</li>
          <li>Sent the job to Microsoft Edge</li>
          <li>Delivered the output to your printer</li>
        </ul>
        
        <hr>
        <small>Generated by High-Performance Print Server v1.0</small>
      </body>
      </html>
    `;

    // Encode HTML to base64
    const base64Html = Buffer.from(testHtml).toString('base64');

    // Submit test print job
    const request: PrintRequest = {
      id: uuidv4(),
      printerName: printerName,
      htmlContent: base64Html,
      metadata: {
        ageGroup: 'test',
        priority: 'high',
        copies: 1,
        paperSize: 'A4',
        orientation: 'portrait'
      },
      timestamp: Date.now(),
      retryCount: 0
    };

    const jobId: string = printService.submitPrintJob(request);
    
    const response: ApiResponse<{ jobId: string, message: string }> = {
      success: true,
      data: { 
        jobId,
        message: `Test print job submitted to '${printerName}'. Check your printer for output.`
      },
      message: 'Test print initiated successfully'
    };
    
    res.json(response);

  } catch (error: any) {
    const response: ApiResponse = {
      success: false,
      error: `Test print failed: ${error.message}`
    };
    res.status(500).json(response);
  }
});

export default router;