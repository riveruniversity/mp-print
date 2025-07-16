import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { PrinterStatus, PrinterStatusType, PrintMetadata, WindowsPrinter } from '../types';
import { config } from '../config';
import logger from '../utils/logger';

const execAsync = promisify(exec);

export class PrinterService {
  private printers: Map<string, PrinterStatus> = new Map();
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  private browser?: Browser;
  private wkhtmltopdfPath?: string;

  public async initialize(): Promise<void> {
    await this.findWkhtmltopdf();
    await this.initializePuppeteer();
    await this.discoverPrinters();
    this.startHealthCheck();
  }

  private async initializePuppeteer(): Promise<void> {
    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
        ]
      });
      logger.info('Puppeteer browser initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Puppeteer:', error);
      throw new Error('Puppeteer initialization failed');
    }
  }

  private async findWkhtmltopdf(): Promise<void> {
    const possiblePaths = [
      'C:\\Program Files\\wkhtmltopdf\\bin\\wkhtmltopdf.exe',
      'C:\\Program Files (x86)\\wkhtmltopdf\\bin\\wkhtmltopdf.exe',
      'wkhtmltopdf.exe' // System PATH
    ];

    for (const path of possiblePaths) {
      try {
        if (path === 'wkhtmltopdf.exe') {
          // Test if it's in PATH
          await execAsync('where wkhtmltopdf.exe');
          this.wkhtmltopdfPath = path;
          logger.info('Found wkhtmltopdf in system PATH - available as fallback');
          return;
        } else if (existsSync(path)) {
          this.wkhtmltopdfPath = path;
          logger.info(`Found wkhtmltopdf at: ${path} - available as fallback`);
          return;
        }
      } catch (error) {
        // Continue to next path
      }
    }

    logger.warn('wkhtmltopdf not found - Puppeteer will be the only available method');
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

  public async printLabel(printerName: string, htmlContent: string, metadata: Partial<PrintMetadata>): Promise<void> {
    const copies = metadata.copies || 1;
    const printer: PrinterStatus | undefined = this.printers.get(printerName);
    if (!printer || printer.status !== 'online') {
      throw new Error(`Printer ${printerName} is not available`);
    }

    try {
      // Decode base64 HTML content
      const decodedHtml: string = Buffer.from(htmlContent, 'base64').toString('utf8');

      // Create enhanced HTML with print-specific CSS
      const enhancedHtml = this.enhanceHtmlForPrinting(decodedHtml);

      const totalStartTime = Date.now();

      // Try Puppeteer first (primary method), fallback to wkhtmltopdf
      if (this.browser) {
        try {
          await this.printWithPuppeteer(enhancedHtml, printerName, copies, metadata);
        } catch (error) {
          logger.warn(`❌ PUPPETEER FAILED: ${error}, falling back to wkhtmltopdf`);
          if (this.wkhtmltopdfPath) {
            await this.printWithWkhtmltopdf(enhancedHtml, printerName, copies, metadata);
          } else {
            throw new Error('Both Puppeteer and wkhtmltopdf are unavailable');
          }
        }
      } else if (this.wkhtmltopdfPath) {
        // Use wkhtmltopdf as fallback if Puppeteer is not available
        logger.info(`=== WKHTMLTOPDF FALLBACK METHOD ===`);
        await this.printWithWkhtmltopdf(enhancedHtml, printerName, copies, metadata);
      } else {
        throw new Error('Neither Puppeteer nor wkhtmltopdf is available');
      }

      const totalTime = Date.now() - totalStartTime;
      logger.info(`📊 TOTAL PRINT JOB: ${copies} copies completed in ${totalTime}ms`);

      logger.info(`Successfully printed ${copies} copies to ${printerName}`);
    } catch (error: any) {
      logger.error(`Print failed for printer ${printerName}:`, error);
      throw error;
    }
  }


  private async printWithPuppeteer(html: string, printerName: string, copies: number, metadata: Partial<PrintMetadata>): Promise<void> {
    if (!this.browser) {
      throw new Error('Puppeteer browser not initialized');
    }

    logger.info(`=== PUPPETEER PRIMARY METHOD ===`);
    const puppeteerStartTime = Date.now();

    try {
      const page: Page = await this.browser.newPage();

      // Set page content
      await page.setContent(html, { waitUntil: 'networkidle0' });

      // Configure PDF options
      const pdfOptions = {
        // format: 'A4' as const,
        printBackground: true,
        width: '10in',
        height: '1in',
        margin: {
          top: '0mm',
          right: '0mm',
          bottom: '0mm',
          left: '0mm'
        }
      };

      // Override format if custom dimensions are needed
      // if (metadata?.paperSize) {
      //   pdfOptions.format = metadata.paperSize as any;
      // }

      // Generate PDF for each copy
      for (let i = 0; i < copies; i++) {
        const copyStartTime = Date.now();

        // Generate PDF buffer
        const pdfBuffer = await page.pdf(pdfOptions);

        // Create temporary PDF file
        const timestamp = Date.now();
        const randomId = Math.random().toString(36).substr(2, 9);
        const pdfFileName = `temp_${timestamp}_${randomId}_copy${i + 1}.pdf`;
        const tmpDir = join(process.cwd(), 'tmp');
        if (!existsSync(tmpDir)) {
          require('fs').mkdirSync(tmpDir, { recursive: true });
        }
        const pdfFilePath = join(tmpDir, pdfFileName);

        // Write PDF to file
        writeFileSync(pdfFilePath, pdfBuffer);

        // Print PDF using PDFtoPrinter.exe
        const binDir = join(process.cwd(), 'bin');
        const pdfToPrinterPath = join(binDir, 'PDFtoPrinter.exe');
        const printCommand = `"${pdfToPrinterPath}" "${pdfFilePath}" "${printerName}"`;

        await execAsync(printCommand, { timeout: 10000 });

        // Clean up PDF file
        setTimeout(() => {
          try {
            if (existsSync(pdfFilePath)) {
              unlinkSync(pdfFilePath);
            }
          } catch (cleanupError) {
            logger.warn(`Failed to cleanup PDF file:`, cleanupError);
          }
        }, 2000);

        const copyDuration = Date.now() - copyStartTime;
        logger.debug(`⚡ Puppeteer copy ${i + 1}/${copies}: ${copyDuration}ms`);

        // Small delay between copies
        if (i < copies - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      await page.close();

      const puppeteerTime = Date.now() - puppeteerStartTime;
      logger.info(`✅ PUPPETEER PRIMARY: ${copies} copies printed in ${puppeteerTime}ms (avg: ${Math.round(puppeteerTime / copies)}ms per copy)`);

    } catch (error: any) {
      logger.error(`❌ Puppeteer primary method failed: ${error.message}`);
      throw error;
    }
  }

  private async printWithWkhtmltopdf(html: string, printerName: string, copies: number, metadata: Partial<PrintMetadata>): Promise<void> {
    const startTime = Date.now();

    logger.info(`=== WKHTMLTOPDF FALLBACK METHOD ===`);

    try {
      for (let i: number = 0; i < copies; i++) {
        await this.printSingleCopyWithWkhtmltopdf(html, printerName, i + 1, copies, metadata);
      }

      const wkhtmltopdfTime = Date.now() - startTime;
      logger.info(`✅ WKHTMLTOPDF FALLBACK: ${copies} copies printed in ${wkhtmltopdfTime}ms (avg: ${Math.round(wkhtmltopdfTime / copies)}ms per copy)`);

    } catch (error: any) {
      logger.error(`❌ wkhtmltopdf fallback failed: ${error.message}`);
      throw error;
    }
  }

  private async printSingleCopyWithWkhtmltopdf(html: string, printerName: string, copyNumber: number, totalCopies: number, metadata: Partial<PrintMetadata>): Promise<void> {
    const startTime = Date.now();

    try {
      // Create temporary HTML file
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

      // Build wkhtmltopdf command
      const args = [
        '--margin-top 0',
        '--margin-bottom 0',
        '--margin-left 0',
        '--margin-right 0',
        '--enable-local-file-access',
        '--page-width 1in',
        '--page-height 10in'
      ];

      if (metadata?.orientation) {
        args.push('--orientation ' + metadata.orientation);
      }

      args.push(`"${htmlFilePath}"`, `"${pdfFile}"`);

      const convertCommand = `"${this.wkhtmltopdfPath}" ${args.join(' ')}`;
      await execAsync(convertCommand, { timeout: 5000 });

      // Print PDF using PDFtoPrinter.exe
      const binDir = join(process.cwd(), 'bin');
      const pdfToPrinterPath = join(binDir, 'PDFtoPrinter.exe');
      const printCommand = `"${pdfToPrinterPath}" "${pdfFile}" "${printerName}"`;

      await execAsync(printCommand, { timeout: 5000 });

      // Clean up files
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
      logger.debug(`⚡ wkhtmltopdf copy ${copyNumber}/${totalCopies}: ${duration}ms`);

      // Small delay between copies
      if (copyNumber < totalCopies) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

    } catch (error: any) {
      const duration = Date.now() - startTime;
      logger.error(`❌ wkhtmltopdf copy ${copyNumber} failed after ${duration}ms: ${error.message}`);
      throw error;
    }
  }


  private enhanceHtmlForPrinting(html: string): string {
    // Add print-specific CSS if not already present
    const printCss = `
      <style>
        @media print {
          body { margin: 0; padding: 0; }
          @page { margin: 0; size: auto; }
          * { -webkit-print-color-adjust: exact !important; color-adjust: exact !important; }
        }
      </style>
    `;

    // Check if HTML already has print styles
    if (!html.toLowerCase().includes('@media print') && !html.toLowerCase().includes('@page')) {
      // Insert CSS before closing head tag, or at the beginning if no head tag
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

      const base64Html = Buffer.from(testHtml).toString('base64');
      await this.printLabel(printerName, base64Html, { copies: 1 });
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