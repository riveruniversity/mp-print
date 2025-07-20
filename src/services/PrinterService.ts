// Enhanced PrinterService.ts - Fixed background hanging issues

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

  // FIXED: Add background operation tracking
  private backgroundOperationActive = false;

  public async initialize(): Promise<void> {
    await this.browserService.initialize();
    this.browser = this.browserService.browser;

    await this.discoverPrinters();
    this.startHealthCheck();
  }

  private async discoverPrinters(): Promise<void> {
    try {
      const command: string = `powershell -Command "Get-Printer | Select-Object PrinterStatus, Name, DriverName, PortName | ConvertTo-Json -Compress"`;

      // FIXED: More aggressive timeout for discovery
      const { stdout }: { stdout: string; } = await execAsync(command, { timeout: 3000 });

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
    // FIXED: Longer interval to reduce background activity
    this.healthCheckInterval = setInterval(async (): Promise<void> => {
      // FIXED: Skip if another background operation is running
      if (this.backgroundOperationActive) {
        logger.debug('Skipping health check - background operation in progress');
        return;
      }
      
      await this.checkPrinterHealth();
    }, Math.max(config.printing.printerHealthCheckInterval, 60000)); // At least 60 seconds
  }

  private async checkPrinterHealth(): Promise<void> {
    // FIXED: Prevent overlapping background operations
    if (this.backgroundOperationActive) {
      return;
    }

    this.backgroundOperationActive = true;
    
    try {
      // FIXED: Process only a few printers per cycle to avoid blocking
      const printerEntries = Array.from(this.printers.entries());
      const batchSize = Math.min(3, printerEntries.length); // Max 3 printers per check
      
      for (let i = 0; i < batchSize; i++) {
        const [printerName, status] = printerEntries[i];
        
        try {
          // FIXED: Much shorter timeout and simpler command
          const command: string = `powershell -Command "try { Get-Printer -Name '${printerName}' -ErrorAction Stop | Select-Object PrinterStatus | ConvertTo-Json -Compress } catch { Write-Output 'ERROR' }"`;
          
          const healthPromise = execAsync(command, { timeout: 2000 });
          const timeoutPromise = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('Health check timeout')), 2000)
          );
          
          const { stdout } = await Promise.race([healthPromise, timeoutPromise]);

          if (!stdout || stdout.trim() === 'ERROR' || stdout.trim() === '') {
            status.status = 'offline';
            status.errorCount++;
          } else {
            try {
              const result = JSON.parse(stdout);
              const newStatus: PrinterStatusType = this.mapPrinterStatus(result.PrinterStatus);
              
              if (newStatus !== status.status) {
                logger.info(`Printer ${printerName} status changed from ${status.status} to ${newStatus}`);
                status.status = newStatus;
                
                if (newStatus === 'online') {
                  this.printerErrorCounts.set(printerName, 0);
                }
              }
            } catch (parseError) {
              status.status = 'offline';
              status.errorCount++;
            }
          }
        } catch (error: any) {
          logger.debug(`Health check failed for printer ${printerName}: ${error.message}`);
          status.status = 'error';
          status.errorCount++;
          
          const currentErrors = this.printerErrorCounts.get(printerName) || 0;
          this.printerErrorCounts.set(printerName, currentErrors + 1);
          this.printerLastError.set(printerName, Date.now());
        }
        
        // FIXED: Small delay between printer checks to prevent overwhelming system
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error: any) {
      logger.error('Health check cycle failed:', error);
    } finally {
      this.backgroundOperationActive = false;
    }
  }

  public getPrinterStatus(printerName: string): PrinterStatus | undefined {
    return this.printers.get(printerName);
  }

  public getAllPrinters(): PrinterStatus[] {
    try {
      const printersArray = Array.from(this.printers.values());
      return printersArray;
    } catch (error) {
      logger.error('Error accessing printers Map:', error);
      return [];
    }
  }

  public isOnline(printerName: string): boolean {
    const printer: PrinterStatus | undefined = this.printers.get(printerName);
    if (!printer || printer.status !== 'online') {
      return false;
    }
    
    const errorCount = this.printerErrorCounts.get(printerName) || 0;
    const lastError = this.printerLastError.get(printerName) || 0;
    const timeSinceLastError = Date.now() - lastError;
    
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

    if (!this.isOnline(label.printerName)) {
      throw new Error(`Printer ${label.printerName} is unstable or has recent errors`);
    }

    try {
      const decodedHtml: string = Buffer.from(label.htmlContent, 'base64').toString('utf8');
      const enhancedHtml = this.enhanceHtmlForPrinting(decodedHtml, label);

      const totalStartTime = Date.now();

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

      this.printerErrorCounts.set(label.printerName, 0);

    } catch (error: any) {
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
      // FIXED: Shorter page creation timeout
      const pagePromise = this.browser!.newPage();
      const pageTimeout = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Page creation timeout')), 5000)
      );
      
      page = await Promise.race([pagePromise, pageTimeout]);

      await page.setViewport({
        width: 800,
        height: 600,
        deviceScaleFactor: 1
      });

      logger.debug('Setting page content...');
      
      // Keep networkidle0 for image loading but add safety timeout wrapper
      const contentPromise = page.setContent(html, {
        waitUntil: 'networkidle0', // KEEP: Required for URL images to load properly
        timeout: 20000 // Reasonable timeout for content + images
      });
      
      const contentTimeout = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Page content timeout - images may not have loaded')), 25000)
      );
      
      await Promise.race([contentPromise, contentTimeout]);
      
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
        timeout: 8000 // FIXED: Reduced from 10000
      };

      logger.debug('Starting parallel PDF generation...');

      const copyPromises = Array.from({ length: label.copies }, async (_, i) => {
        const copyNumber = i + 1;
        const copyStartTime = Date.now();
        
        try {
          logger.debug(`Generating PDF for copy ${copyNumber}/${label.copies}...`);

          // FIXED: Add timeout wrapper for PDF generation
          const pdfPromise = page!.pdf(pdfOptions);
          const pdfTimeout = new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error('PDF generation timeout')), 8000)
          );
          
          const pdfBuffer = await Promise.race([pdfPromise, pdfTimeout]);
          logger.debug(`PDF generated successfully for copy ${copyNumber}`);

          const timestamp = Date.now();
          const pdfFileName = `parallel_${timestamp}_${copyNumber}.pdf`;
          const tmpDir = join(process.cwd(), 'tmp');
          const pdfFilePath = join(tmpDir, pdfFileName);

          if (!existsSync(tmpDir)) {
            await fs.mkdir(tmpDir, { recursive: true });
          }

          await fs.writeFile(pdfFilePath, pdfBuffer);
          logger.debug(`PDF file written: ${pdfFilePath}`);

          const binDir = join(process.cwd(), 'bin');
          const pdfToPrinterPath = join(binDir, 'PDFtoPrinter.exe');
          const printCommand = `"${pdfToPrinterPath}" "${pdfFilePath}" "${label.printerName}"`;

          logger.debug(`Executing print command for copy ${copyNumber}...`);
          
          // FIXED: Shorter print timeout
          await execAsync(printCommand, { timeout: 10000 });
          logger.debug(`Print command completed for copy ${copyNumber}`);

          // FIXED: Immediate cleanup instead of delayed
          setTimeout(async () => {
            try {
              if (existsSync(pdfFilePath)) {
                await fs.unlink(pdfFilePath);
              }
            } catch (cleanupError) {
              logger.debug('Cleanup error (ignored):', cleanupError);
            }
          }, 2000); // FIXED: Reduced from 5000

          const copyTime = Date.now() - copyStartTime;
          logger.debug(`✅ Copy ${copyNumber} completed in ${copyTime}ms`);

          return { copyNumber, success: true, time: copyTime };

        } catch (error: any) {
          const copyTime = Date.now() - copyStartTime;
          logger.error(`❌ Copy ${copyNumber} failed after ${copyTime}ms:`, error.message);
          
          return { copyNumber, success: false, time: copyTime, error: error.message };
        }
      });

      const results = await Promise.allSettled(copyPromises);
      
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
        
        if (failed.length > successful.length) {
          throw new Error(`Print job mostly failed: ${failed.length}/${label.copies} copies failed`);
        }
      } else {
        throw new Error(`All ${label.copies} copies failed to print`);
      }

      // FIXED: More aggressive garbage collection
      if (results.length > 3) {
        if (global.gc) global.gc();
      }

    } catch (error: any) {
      logger.error(`❌ Parallel printing failed: ${error.message}`);
      throw error;
    } finally {
      if (page) {
        try {
          if (!page.isClosed()) {
            logger.debug('Closing page...');
            
            // FIXED: Add timeout to page closing
            const closePromise = page.close();
            const closeTimeout = new Promise<never>((_, reject) => 
              setTimeout(() => reject(new Error('Page close timeout')), 3000)
            );
            
            await Promise.race([closePromise, closeTimeout]);
            logger.debug('Page closed successfully');
          }
        } catch (closeError: any) {
          logger.warn('Error closing page:', closeError.message);
          // FIXED: Force page to null even if close fails
          page = null;
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

      const printer: PrinterStatus | undefined = this.printers.get(printerName);
      if (!printer || printer.status !== 'online') {
        throw new Error(`Printer ${printerName} is not available`);
      }

      const zplCommands = [
        '~SD20',
        '~JSN',
        '^XA',
        '^SZ2',
        '^PW203',
        '^LL2030',
        '^POI',
        '^PMN',
        '^MNM',
        '^LS0',
        '^MTT',
        '^MMT,N',
        '^MPE',
        '^XZ',
        '^XA^JUS^XZ'
      ].join('\n');

      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const tempFile: string = `zebra_reset_${timestamp}_${randomId}.zpl`;
      const tmpDir = join(process.cwd(), 'tmp');

      if (!existsSync(tmpDir)) {
        await fs.mkdir(tmpDir, { recursive: true });
      }

      const fullTempPath = join(tmpDir, tempFile);
      await fs.writeFile(fullTempPath, zplCommands, 'utf8');

      const copyCommand = `copy "${fullTempPath}" "${printerName}"`;

      try {
        // FIXED: Shorter timeout for ZPL commands
        const { stdout, stderr } = await execAsync(copyCommand, { timeout: 5000 });
        logger.info(`✅ ZPL commands sent successfully to ${printerName}`);

        // FIXED: Immediate cleanup
        setTimeout(async () => {
          try {
            if (existsSync(fullTempPath)) {
              await fs.unlink(fullTempPath);
            }
          } catch (cleanupError) {
            logger.warn(`Failed to cleanup ZPL temp file ${tempFile}:`, cleanupError);
          }
        }, 1000); // FIXED: Reduced from 2000

        return true;
      } catch (error: any) {
        logger.error(`Failed to send ZPL commands to ${printerName}:`, error);

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
      printerLastErrors: Object.fromEntries(this.printerLastError),
      backgroundOperationActive: this.backgroundOperationActive // FIXED: Add monitoring
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
    // FIXED: Clear background operation flag
    this.backgroundOperationActive = false;
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    if (this.browser) {
      this.browser.close().catch(error => {
        logger.error('Error closing Puppeteer browser:', error);
      });
    }
    
    // FIXED: Clear all maps
    this.printers.clear();
    this.printerErrorCounts.clear();
    this.printerLastError.clear();
  }
}