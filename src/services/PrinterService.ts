// Enhanced PrinterService.ts with async processing and error isolation

import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { Browser, Page } from 'puppeteer';
import { PrinterStatus, PrinterStatusType, PrintLabel, PrintMetadata, WindowsPrinter } from '../types';
import { config } from '../config';
import logger from '../utils/logger';
import { BrowserService } from './BrowserService';

const execAsync = promisify(exec);

export class PrinterService {

  private browserService = new BrowserService();
  private browser?: Browser;

  private printers: Map<string, PrinterStatus> = new Map();
  private healthCheckInterval?: ReturnType<typeof setInterval>;

  // Track printer-specific errors to isolate issues
  private printerErrorCounts: Map<string, number> = new Map();
  private printerLastError: Map<string, number> = new Map();

  public async initialize(): Promise<void> {
    await this.browserService.initialize();
    this.browser = this.browserService.browser;

    await this.discoverPrinters();
    this.startHealthCheck();
  }

  private async discoverPrinters(): Promise<void> {
    try {
      const command: string = `powershell -Command "Get-Printer | Select-Object PrinterStatus, Name, DriverName, PortName | ConvertTo-Json -Compress"`;

      // Add timeout to prevent hanging
      const { stdout }: { stdout: string; } = await execAsync(command, { timeout: 5000 });

      if (!stdout || stdout.trim() === '' || stdout.trim() === 'null') {
        logger.warn('No printers discovered');
        return;
      }
      const printers: WindowsPrinter | WindowsPrinter[] = JSON.parse(stdout);

      const printerArray: WindowsPrinter[] = Array.isArray(printers) ? printers : [printers];

      for (const printer of printerArray) {
        this.printers.set(printer.Name, {
          name: printer.Name,
          port: printer.PortName,
          driver: printer.DriverName,
          status: this.mapPrinterStatus(printer.PrinterStatus),
          jobsInQueue: 0,
          errorCount: 0
        });
        
        // Initialize error tracking
        this.printerErrorCounts.set(printer.Name, 0);
        this.printerLastError.set(printer.Name, 0);
      }

      console.log('🖨️  printers', printerArray.map(p => p.Name));
      logger.info(`Discovered ${this.printers.size} printers`);
    } catch (error: any) {
      logger.error('Failed to discover printers:', error);
    }
  }

  private mapPrinterStatus(status: number): PrinterStatusType {
    // Windows printer status mapping
    switch (status) {
      case 0: return 'online';
      case 1: return 'offline';
      case 2: return 'error';
      default: return 'offline';
    }
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async (): Promise<void> => {
      await this.checkPrinterHealth();
    }, config.printing.printerHealthCheckInterval);
  }

  private async checkPrinterHealth(): Promise<void> {
    // Process all printer health checks in parallel with timeouts
    const healthCheckPromises = Array.from(this.printers.entries()).map(async ([printerName, status]) => {
      try {
        const command: string = `powershell -Command "Get-Printer -Name '${printerName}' | Select-Object PrinterStatus, Name, DriverName, PortName | ConvertTo-Json -Compress"`;
        
        // Add timeout to prevent hanging on individual printer checks
        const { stdout }: { stdout: string; } = await execAsync(command, { timeout: 3000 });

        if (!stdout || stdout.trim() === '' || stdout.trim() === 'null') {
          logger.warn(`No printer data returned for ${printerName}`);
          status.status = 'offline';
          status.errorCount++;
          return;
        }
        
        const result: { PrinterStatus: number, Name: string, DriverName: string, PortName: string; } = JSON.parse(stdout);
        const newStatus: PrinterStatusType = this.mapPrinterStatus(result.PrinterStatus);
        
        if (newStatus !== status.status) {
          logger.info(`Printer ${printerName} status changed from ${status.status} to ${newStatus}`);
          status.status = newStatus;
          
          // Reset error count if printer comes back online
          if (newStatus === 'online') {
            this.printerErrorCounts.set(printerName, 0);
          }
        }
      } catch (error: any) {
        logger.warn(`Health check failed for printer ${printerName}:`, error);
        status.status = 'error';
        status.errorCount++;
        
        // Track printer-specific errors
        const currentErrors = this.printerErrorCounts.get(printerName) || 0;
        this.printerErrorCounts.set(printerName, currentErrors + 1);
        this.printerLastError.set(printerName, Date.now());
      }
    });

    // Wait for all health checks to complete, but don't let one failure block others
    await Promise.allSettled(healthCheckPromises);
  }

  public getPrinterStatus(printerName: string): PrinterStatus | undefined {
    return this.printers.get(printerName);
  }

  public getAllPrinters(): PrinterStatus[] {
    try {
      // Add timeout protection for Map access
      const printersArray = Array.from(this.printers.values());
      return printersArray;
    } catch (error) {
      logger.error('Error accessing printers Map:', error);
      return []; // Return empty array if there's an issue
    }
  }

  public isOnline(printerName: string): boolean {
    const printer: PrinterStatus | undefined = this.printers.get(printerName);
    if (!printer || printer.status !== 'online') {
      return false;
    }
    
    // Check if printer has had too many recent errors
    const errorCount = this.printerErrorCounts.get(printerName) || 0;
    const lastError = this.printerLastError.get(printerName) || 0;
    const timeSinceLastError = Date.now() - lastError;
    
    // If printer has had more than 3 errors in the last 5 minutes, consider it unstable
    if (errorCount > 3 && timeSinceLastError < 300000) {
      logger.warn(`Printer ${printerName} considered unstable due to recent errors`);
      return false;
    }
    
    return true;
  }

  public updateJobCount(printerName: string, delta: number): void {
    const printer: PrinterStatus | undefined = this.printers.get(printerName);
    if (printer) {
      printer.jobsInQueue = Math.max(0, printer.jobsInQueue + delta);
      printer.lastJobTime = Date.now();
    }
  }

  public async printLabel(label: PrintLabel, metadata: PrintMetadata): Promise<void> {
    const printer: PrinterStatus | undefined = this.printers.get(label.printerName);
    if (!printer || printer.status !== 'online') {
      throw new Error(`Printer ${label.printerName} is not available`);
    }

    // Check if printer is stable
    if (!this.isOnline(label.printerName)) {
      throw new Error(`Printer ${label.printerName} is unstable or has recent errors`);
    }

    try {
      const decodedHtml: string = Buffer.from(label.htmlContent, 'base64').toString('utf8');
      const enhancedHtml = this.enhanceHtmlForPrinting(decodedHtml, label);

      const totalStartTime = Date.now();

      // Only use Puppeteer - no fallback needed
      if (!this.browser || !this.browser.connected) {
        await this.browserService.reinitializeBrowser();
        this.browser = this.browserService.browser;
        if (!this.browser || !this.browser.connected) {
          throw new Error('Browser not available');
        }
      }

      await this.printWithPuppeteer(enhancedHtml, label, metadata);

      const totalTime = Date.now() - totalStartTime;
      logger.info(`📊 LABEL PRINT: ${label.copies} copies of "${label.name}" completed in ${totalTime}ms`);

      // Reset error count on successful print
      this.printerErrorCounts.set(label.printerName, 0);

    } catch (error: any) {
      // Track printer-specific error
      const currentErrors = this.printerErrorCounts.get(label.printerName) || 0;
      this.printerErrorCounts.set(label.printerName, currentErrors + 1);
      this.printerLastError.set(label.printerName, Date.now());
      
      logger.error(`Print failed for label "${label.name}" on printer ${label.printerName}:`, error);
      throw error;
    }
  }

  private async printWithPuppeteer(html: string, label: PrintLabel, metadata: PrintMetadata): Promise<void> {
    logger.info(`=== PUPPETEER PARALLEL PROCESSING ===`);
    const startTime = Date.now();

    let page: Page | null = null;

    try {
      page = await this.browser!.newPage();

      await page.setViewport({
        width: 800,
        height: 600,
        deviceScaleFactor: 1
      });

      logger.debug('Setting page content...');
      await page.setContent(html, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
      logger.debug('Page content set successfully');

      const pdfOptions = {
        format: undefined,
        printBackground: true,
        width: label.width,
        height: label.height,
        margin: {
          top: label.margin.top,
          right: label.margin.right,
          bottom: label.margin.bottom,
          left: label.margin.left
        },
        preferCSSPageSize: true,
        timeout: 10000
      };

      logger.debug('Starting parallel PDF generation...');

      // Create all copy processing promises in parallel
      const copyPromises = Array.from({ length: label.copies }, async (_, i) => {
        const copyNumber = i + 1;
        const copyStartTime = Date.now();
        
        try {
          logger.debug(`Generating PDF for copy ${copyNumber}/${label.copies}...`);

          const pdfBuffer = await page!.pdf(pdfOptions);
          logger.debug(`PDF generated successfully for copy ${copyNumber}`);

          const timestamp = Date.now();
          const pdfFileName = `parallel_${timestamp}_${copyNumber}.pdf`;
          const tmpDir = join(process.cwd(), 'tmp');
          const pdfFilePath = join(tmpDir, pdfFileName);

          // Ensure tmp directory exists
          if (!existsSync(tmpDir)) {
            await fs.mkdir(tmpDir, { recursive: true });
          }

          // Use async file write
          await fs.writeFile(pdfFilePath, pdfBuffer);
          logger.debug(`PDF file written: ${pdfFilePath}`);

          const binDir = join(process.cwd(), 'bin');
          const pdfToPrinterPath = join(binDir, 'PDFtoPrinter.exe');
          const printCommand = `"${pdfToPrinterPath}" "${pdfFilePath}" "${label.printerName}"`;

          logger.debug(`Executing print command for copy ${copyNumber}...`);
          await execAsync(printCommand, { timeout: 15000 });
          logger.debug(`Print command completed for copy ${copyNumber}`);

          // Async cleanup
          setTimeout(async () => {
            try {
              if (existsSync(pdfFilePath)) {
                await fs.unlink(pdfFilePath);
              }
            } catch (cleanupError) {
              logger.debug('Cleanup error (ignored):', cleanupError);
            }
          }, 5000);

          const copyTime = Date.now() - copyStartTime;
          logger.debug(`✅ Copy ${copyNumber} completed in ${copyTime}ms`);

          return { copyNumber, success: true, time: copyTime };

        } catch (error: any) {
          const copyTime = Date.now() - copyStartTime;
          logger.error(`❌ Copy ${copyNumber} failed after ${copyTime}ms:`, error.message);
          
          // Don't throw here - let other copies continue
          return { copyNumber, success: false, time: copyTime, error: error.message };
        }
      });

      // Wait for all copies to complete
      const results = await Promise.allSettled(copyPromises);
      
      // Process results
      const successful = results.filter((result, i) => 
        result.status === 'fulfilled' && result.value.success
      );
      
      const failed = results.filter((result, i) => 
        result.status === 'rejected' || 
        (result.status === 'fulfilled' && !result.value.success)
      );

      const totalTime = Date.now() - startTime;
      
      if (successful.length === label.copies) {
        logger.info(`✅ PARALLEL SUCCESS: ${label.copies} copies in ${totalTime}ms (${Math.round(totalTime / label.copies)}ms/copy avg)`);
      } else if (successful.length > 0) {
        logger.warn(`⚠️ PARTIAL SUCCESS: ${successful.length}/${label.copies} copies completed in ${totalTime}ms`);
        logger.warn(`Failed copies: ${failed.length}`);
        
        // If more than half failed, throw error
        if (failed.length > successful.length) {
          throw new Error(`Print job mostly failed: ${failed.length}/${label.copies} copies failed`);
        }
      } else {
        throw new Error(`All ${label.copies} copies failed to print`);
      }

      // Force garbage collection for large PDFs
      if (results.length > 5) {
        if (global.gc) global.gc();
      }

    } catch (error: any) {
      logger.error(`❌ Parallel printing failed: ${error.message}`);
      logger.error('Error stack:', error.stack);

      // Log browser state for debugging
      try {
        if (this.browser) {
          const pages = await this.browser.pages();
          logger.debug(`Browser state: connected=${this.browser.connected}, pages=${pages.length}`);
        }
        if (page && !page.isClosed()) {
          logger.debug('Page state: not closed');
        } else {
          logger.debug('Page state: closed or null');
        }
      } catch (stateError) {
        logger.debug('Error checking browser/page state:', stateError);
      }

      throw error;
    } finally {
      if (page) {
        try {
          if (!page.isClosed()) {
            logger.debug('Closing page...');
            await page.close();
            logger.debug('Page closed successfully');
          } else {
            logger.debug('Page was already closed');
          }
        } catch (closeError: any) {
          logger.warn('Error closing page:', closeError.message);
        }
      }
    }
  }

  private enhanceHtmlForPrinting(html: string, label: PrintLabel): string {
    const printCss = `
    <style>
      @media print {
        body { 
          margin: ${label.margin.top} ${label.margin.right} ${label.margin.bottom} ${label.margin.left}; 
          padding: 0; 
        }
        @page { 
          margin: 0; 
          size: ${label.width} ${label.height}; 
          ${label.orientation ? `orientation: ${label.orientation};` : ''}
        }
        * { -webkit-print-color-adjust: exact !important; color-adjust: exact !important; }
      }
    </style>
  `;

    if (!html.toLowerCase().includes('@media print') && !html.toLowerCase().includes('@page')) {
      if (html.toLowerCase().includes('</head>')) {
        return html.replace(/<\/head>/i, `${printCss}</head>`);
      } else if (html.toLowerCase().includes('<html>')) {
        return html.replace(/<html[^>]*>/i, `$&${printCss}`);
      } else {
        return `${printCss}${html}`;
      }
    }

    return html;
  }

  public async resetZebraMediaValues(printerName: string): Promise<boolean> {
    try {
      logger.info(`Resetting media values for Zebra printer: ${printerName}`);

      // Check if printer exists and is online
      const printer: PrinterStatus | undefined = this.printers.get(printerName);
      if (!printer || printer.status !== 'online') {
        throw new Error(`Printer ${printerName} is not available`);
      }

      // ZPL commands to reset media values
      const zplCommands = [
        '~SD20',        // Set darkness to 20
        '~JSN',         // Disable JSON
        '^XA',          // Start format
        '^SZ2',         // Set ZPL mode to ZPL II
        '^PW203',       // Set print width to 203 dots (1 inch at 203 DPI)
        '^LL2030',      // Set label length to 2030 dots (10 inches at 203 DPI)
        '^POI',         // Print orientation (N)ormal | (I)nverted
        '^PMN',         // Print method normal
        '^MNM',         // Media tracking method - non-continuous (gap/notch)
        '^LS0',         // Label shift 0
        '^MTT',         // Media type thermal transfer
        '^MMT,N',       // Print mode thermal transfer, normal
        '^MPE',         // Mode print and cut
        '^XZ',          // End format
        '^XA^JUS^XZ'    // Reset all settings and save
      ].join('\n');

      // Create temporary ZPL file
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const tempFile: string = `zebra_reset_${timestamp}_${randomId}.zpl`;
      const tmpDir = join(process.cwd(), 'tmp');

      if (!existsSync(tmpDir)) {
        await fs.mkdir(tmpDir, { recursive: true });
      }

      const fullTempPath = join(tmpDir, tempFile);
      await fs.writeFile(fullTempPath, zplCommands, 'utf8');

      // Send ZPL commands to printer using Windows copy command with timeout
      const copyCommand = `copy "${fullTempPath}" "${printerName}"`;

      try {
        const { stdout, stderr } = await execAsync(copyCommand, { timeout: 8000 }); // Add timeout
        logger.info(`✅ ZPL commands sent successfully to ${printerName}`);

        // Clean up temporary file
        setTimeout(async () => {
          try {
            if (existsSync(fullTempPath)) {
              await fs.unlink(fullTempPath);
            }
          } catch (cleanupError) {
            logger.warn(`Failed to cleanup ZPL temp file ${tempFile}:`, cleanupError);
          }
        }, 2000);

        return true;
      } catch (error: any) {
        logger.error(`Failed to send ZPL commands to ${printerName}:`, error);

        // Clean up temporary file on error
        try {
          if (existsSync(fullTempPath)) {
            await fs.unlink(fullTempPath);
          }
        } catch (cleanupError) {
          logger.warn(`Failed to cleanup ZPL temp file ${tempFile}:`, cleanupError);
        }

        return false;
      }

    } catch (error: any) {
      logger.error(`Reset media values failed for printer ${printerName}:`, error);
      return false;
    }
  }

  public getBrowserStatus() {
    return this.browserService.getPerformanceStats();
  }

  public getPerformanceStats(): any {
    return {
      ...this.getBrowserStatus(),
      memoryUsage: process.memoryUsage(),
      printersOnline: Array.from(this.printers.values()).filter(p => p.status === 'online').length,
      totalPrinters: this.printers.size,
      printerErrors: Object.fromEntries(this.printerErrorCounts),
      printerLastErrors: Object.fromEntries(this.printerLastError)
    };
  }

  public async testPrint(printerName: string): Promise<boolean> {
    try {
      const testHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          @media print {
            body { margin: 0; padding: 10px; font-family: Arial; }
            @page { margin: 0; size: auto; }
          }
        </style>
      </head>
      <body>
        <h2>Print Test</h2>
        <p>Printer: ${printerName}</p>
        <p>Time: ${new Date().toLocaleString()}</p>
        <p>Status: Print service operational</p>
      </body>
      </html>
    `;

      const testLabel: PrintLabel = {
        userId: 12345,
        name: 'Test Print',
        htmlContent: Buffer.from(testHtml).toString('base64'),
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
        copies: 1
      };

      await this.printLabel(testLabel, { priority: 'medium' });
      return true;
    } catch (error) {
      logger.error(`Test print failed for ${printerName}:`, error);
      return false;
    }
  }

  public destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    if (this.browser) {
      this.browser.close().catch(error => {
        logger.error('Error closing Puppeteer browser:', error);
      });
    }
  }
}