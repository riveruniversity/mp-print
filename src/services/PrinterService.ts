// Enhanced PrinterService.ts with optimized Puppeteer usage

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
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

  public async initialize(): Promise<void> {
    await this.browserService.initialize();
    this.browser = this.browserService.browser;

    await this.discoverPrinters();
    this.startHealthCheck();
  }


  private async discoverPrinters(): Promise<void> {
    try {
      const command: string = `powershell -Command "Get-Printer | Select-Object PrinterStatus, Name, DriverName, PortName | ConvertTo-Json -Compress"`;

      const { stdout }: { stdout: string; } = await execAsync(command);

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
    for (const [printerName, status] of this.printers) {
      try {
        const command: string = `powershell -Command "Get-Printer -Name '${printerName}' | Select-Object PrinterStatus, Name, DriverName, PortName | ConvertTo-Json -Compress"`;
        const { stdout }: { stdout: string; } = await execAsync(command);

        if (!stdout || stdout.trim() === '' || stdout.trim() === 'null') {
          logger.warn(`No printer data returned for ${printerName}`);
          status.status = 'offline';
          status.errorCount++;
          continue;
        }
        const result: { PrinterStatus: number, Name: string, DriverName: string, PortName: string; } = JSON.parse(stdout);
        const newStatus: PrinterStatusType = this.mapPrinterStatus(result.PrinterStatus);
        if (newStatus !== status.status) {
          logger.info(`Printer ${printerName} status changed from ${status.status} to ${newStatus}`);
          status.status = newStatus;
        }
      } catch (error: any) {
        logger.warn(`Health check failed for printer ${printerName}:`, error);
        status.status = 'error';
        status.errorCount++;
      }
    }
  }

  public getPrinterStatus(printerName: string): PrinterStatus | undefined {
    return this.printers.get(printerName);
  }

  public getAllPrinters(): PrinterStatus[] {
    return Array.from(this.printers.values());
  }

  public isOnline(printerName: string): boolean {
    const printer: PrinterStatus | undefined = this.printers.get(printerName);
    return printer?.status === 'online';
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

    try {
      const decodedHtml: string = Buffer.from(label.htmlContent, 'base64').toString('utf8');
      const enhancedHtml = this.enhanceHtmlForPrinting(decodedHtml, label);

      const totalStartTime = Date.now();

      if (this.browser) {
        try {
          await this.printWithPuppeteer(enhancedHtml, label, metadata);
        } catch (error) {
          logger.warn(`❌ PUPPETEER FAILED: ${error}, falling back to wkhtmltopdf`);
          if (this.browserService.wkhtmltopdfPath) {
            await this.printWithWkhtmltopdf(enhancedHtml, label, metadata);
          } else {
            throw new Error('Both Puppeteer and wkhtmltopdf are unavailable');
          }
        }
      } else if (this.browserService.wkhtmltopdfPath) {
        await this.printWithWkhtmltopdf(enhancedHtml, label, metadata);
      } else {
        throw new Error('Neither Puppeteer nor wkhtmltopdf is available');
      }

      const totalTime = Date.now() - totalStartTime;
      logger.info(`📊 LABEL PRINT: ${label.copies} copies of "${label.name}" completed in ${totalTime}ms`);

    } catch (error: any) {
      logger.error(`Print failed for label "${label.name}" on printer ${label.printerName}:`, error);
      throw error;
    }
  }


  private async printWithPuppeteer(html: string, label: PrintLabel, metadata: PrintMetadata): Promise<void> {
    if (!this.browser || !this.browser.connected) {
      await this.browserService.reinitializeBrowser();
      this.browser = this.browserService.browser;
      if (!this.browser || !this.browser.connected) {
        throw new Error('Browser not available');
      }
    }

    logger.info(`=== ULTRA-CONSERVATIVE PUPPETEER ===`);
    const startTime = Date.now();

    let page: Page | null = null;

    try {
      page = await this.browser.newPage();

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

      // Use label dimensions instead of hardcoded values
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

      logger.debug('Starting PDF generation...');

      // Generate each copy separately
      for (let i = 0; i < label.copies; i++) {
        logger.debug(`Generating PDF for copy ${i + 1}/${label.copies}...`);

        const pdfBuffer = await page.pdf(pdfOptions);
        logger.debug(`PDF generated successfully for copy ${i + 1}`);

        const timestamp = Date.now();
        const pdfFileName = `conservative_${timestamp}_${i + 1}.pdf`;
        const tmpDir = join(process.cwd(), 'tmp');
        const pdfFilePath = join(tmpDir, pdfFileName);

        if (!existsSync(tmpDir)) {
          require('fs').mkdirSync(tmpDir, { recursive: true });
        }

        writeFileSync(pdfFilePath, pdfBuffer);
        logger.debug(`PDF file written: ${pdfFilePath}`);

        const binDir = join(process.cwd(), 'bin');
        const pdfToPrinterPath = join(binDir, 'PDFtoPrinter.exe');
        const printCommand = `"${pdfToPrinterPath}" "${pdfFilePath}" "${label.printerName}"`;

        logger.debug(`Executing print command for copy ${i + 1}...`);
        await execAsync(printCommand, { timeout: 15000 });
        logger.debug(`Print command completed for copy ${i + 1}`);

        if (pdfBuffer.length > 1024 * 1024) {
          if (global.gc) global.gc();
        }

        setTimeout(() => {
          try {
            if (existsSync(pdfFilePath)) {
              unlinkSync(pdfFilePath);
            }
          } catch (cleanupError) {
            logger.debug('Cleanup error (ignored):', cleanupError);
          }
        }, 5000);

        if (i < label.copies - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const totalTime = Date.now() - startTime;
      logger.info(`✅ ULTRA-CONSERVATIVE: ${label.copies} copies in ${totalTime}ms (${Math.round(totalTime / label.copies)}ms/copy)`);

    } catch (error: any) {
      logger.error(`❌ Ultra-conservative method failed: ${error.message}`);
      logger.error('Error stack:', error.stack);

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



  private async printWithWkhtmltopdf(html: string, label: PrintLabel, metadata: PrintMetadata): Promise<void> {
    const startTime = Date.now();

    logger.info(`=== WKHTMLTOPDF FALLBACK METHOD ===`);

    try {
      for (let i: number = 0; i < label.copies; i++) {
        await this.printSingleCopyWithWkhtmltopdf(html, label, i + 1, metadata);
      }

      const wkhtmltopdfTime = Date.now() - startTime;
      logger.info(`✅ WKHTMLTOPDF FALLBACK: ${label.copies} copies printed in ${wkhtmltopdfTime}ms (avg: ${Math.round(wkhtmltopdfTime / label.copies)}ms per copy)`);

    } catch (error: any) {
      logger.error(`❌ wkhtmltopdf fallback failed: ${error.message}`);
      throw error;
    }
  }

  private async printSingleCopyWithWkhtmltopdf(html: string, label: PrintLabel, copyNumber: number, metadata: PrintMetadata): Promise<void> {
    const startTime = Date.now();

    try {
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const tempFile: string = `temp_${timestamp}_${randomId}.html`;
      const tmpDir = join(process.cwd(), 'tmp');
      if (!existsSync(tmpDir)) {
        require('fs').mkdirSync(tmpDir, { recursive: true });
      }
      const htmlFilePath = join(tmpDir, tempFile);
      const pdfFile = htmlFilePath.replace('.html', '.pdf');

      writeFileSync(htmlFilePath, html, 'utf8');

      // Build wkhtmltopdf command with label dimensions
      const args = [
        `--margin-top ${label.margin.top}`,
        `--margin-bottom ${label.margin.bottom}`,
        `--margin-left ${label.margin.left}`,
        `--margin-right ${label.margin.right}`,
        '--enable-local-file-access',
        `--page-width ${label.width}`,
        `--page-height ${label.height}`
      ];

      if (label.orientation) {
        args.push('--orientation ' + label.orientation);
      }

      args.push(`"${htmlFilePath}"`, `"${pdfFile}"`);

      const convertCommand = `"${this.browserService.wkhtmltopdfPath}" ${args.join(' ')}`;
      await execAsync(convertCommand, { timeout: 5000 });

      const binDir = join(process.cwd(), 'bin');
      const pdfToPrinterPath = join(binDir, 'PDFtoPrinter.exe');
      const printCommand = `"${pdfToPrinterPath}" "${pdfFile}" "${label.printerName}"`;

      await execAsync(printCommand, { timeout: 5000 });

      setTimeout(() => {
        try {
          if (existsSync(htmlFilePath)) {
            unlinkSync(htmlFilePath);
          }
          if (existsSync(pdfFile)) {
            unlinkSync(pdfFile);
          }
        } catch (cleanupError) {
          logger.warn(`Failed to cleanup temp files:`, cleanupError);
        }
      }, 2000);

      const duration = Date.now() - startTime;
      logger.debug(`⚡ wkhtmltopdf copy ${copyNumber}/${label.copies}: ${duration}ms`);

      if (copyNumber < label.copies) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error(`❌ wkhtmltopdf copy ${copyNumber} failed after ${duration}ms: ${error.message}`);
      throw error;
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

      // ZPL commands to reset media values for ZTC ZD620-203dpi
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
        require('fs').mkdirSync(tmpDir, { recursive: true });
      }

      const fullTempPath = join(tmpDir, tempFile);
      writeFileSync(fullTempPath, zplCommands, 'utf8');

      // Send ZPL commands to printer using Windows copy command
      const copyCommand = `copy "${fullTempPath}" "${printerName}"`;

      try {
        const { stdout, stderr } = await execAsync(copyCommand, { timeout: 10000 });
        logger.info(`✅ ZPL commands sent successfully to ${printerName}`);

        // Clean up temporary file
        setTimeout(() => {
          try {
            if (existsSync(fullTempPath)) {
              unlinkSync(fullTempPath);
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
            unlinkSync(fullTempPath);
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
      totalPrinters: this.printers.size
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