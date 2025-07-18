// Enhanced PrinterService.ts with optimized Puppeteer usage

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

  // Page pool for better performance
  private pagePool: Page[] = [];
  private maxPoolSize: number = 5;
  private pagePoolSemaphore: number = 0;
  private browserHealthInterval?: ReturnType<typeof setInterval>;

  public async initialize(): Promise<void> {
    await this.findWkhtmltopdf();
    await this.initializePuppeteer();
    await this.initializePagePool();
    await this.discoverPrinters();
    this.startHealthCheck();
    this.startBrowserHealthCheck();
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






  private async initializePagePool(): Promise<void> {
    logger.info('Page pooling disabled for stability - using fresh pages per job');
    // Don't initialize page pool - we'll create fresh pages for each job
    this.pagePool = [];
    this.maxPoolSize = 0;
    this.pagePoolSemaphore = 0;
  }



  // Ultra-conservative Puppeteer implementation - replace methods in PrinterService.ts

  // 1. Replace initializePuppeteer with ultra-conservative version
  private async initializePuppeteer(): Promise<void> {
    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-extensions',
          '--disable-plugins',
          '--disable-default-apps',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--mute-audio',
          '--no-first-run',
          '--disable-ipc-flooding-protection',
          // Memory optimizations
          '--memory-pressure-off',
        ],
        timeout: 30000, // Very generous timeout
        protocolTimeout: 120000, // 2 minutes protocol timeout
        defaultViewport: {
          width: 800,
          height: 600, // Standard size, not too small
          deviceScaleFactor: 1
        }
      });

      logger.info('Ultra-conservative Puppeteer browser initialized (minimal args)');
    } catch (error: any) {
      logger.error('Failed to initialize ultra-conservative Puppeteer:', error);
      throw new Error('Ultra-conservative Puppeteer initialization failed');
    }
  }

  // 2. Replace printWithPuppeteer with ultra-conservative version
  private async printWithPuppeteer(html: string, printerName: string, copies: number, metadata: Partial<PrintMetadata>): Promise<void> {
    if (!this.browser || !this.browser.connected) {
      throw new Error('Browser not available');
    }

    logger.info(`=== ULTRA-CONSERVATIVE PUPPETEER ===`);
    const startTime = Date.now();

    let page: Page | null = null;

    try {
      // Create page with minimal configuration
      logger.debug('Creating new page...');
      page = await this.browser.newPage();
      logger.debug('Page created successfully');

      // Don't set aggressive optimizations that might cause instability
      // Just set basic viewport
      await page.setViewport({
        width: 800,
        height: 600,
        deviceScaleFactor: 1
      });
      logger.debug('Viewport set');

      // Don't disable JavaScript or set aggressive request interception
      // Keep it simple and stable

      // Use original HTML without aggressive optimization
      const decodedHtml = html; // Use as-is for now
      logger.debug('HTML prepared');

      // Set content with very generous timeout
      logger.debug('Setting page content...');
      await page.setContent(decodedHtml, {
        waitUntil: 'domcontentloaded',
        timeout: 30000 // Very generous timeout
      });
      logger.debug('Page content set successfully');

      // Conservative PDF options
      const pdfOptions = {
        // format: 'A4' as const, // Use standard format
        format: undefined, // Use CSS page size
        printBackground: true,
        width: '10in',
        height: '1in',
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
        preferCSSPageSize: true,
        timeout: 30000 // Very generous PDF generation timeout
      };

      logger.debug('Starting PDF generation...');

      // Simple approach: generate each copy separately (most stable)
      for (let i = 0; i < copies; i++) {
        logger.debug(`Generating PDF for copy ${i + 1}/${copies}...`);

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
        const printCommand = `"${pdfToPrinterPath}" "${pdfFilePath}" "${printerName}"`;

        logger.debug(`Executing print command for copy ${i + 1}...`);
        await execAsync(printCommand, { timeout: 15000 });
        logger.debug(`Print command completed for copy ${i + 1}`);

        // Cleanup
        setTimeout(() => {
          try {
            if (existsSync(pdfFilePath)) {
              unlinkSync(pdfFilePath);
            }
          } catch (cleanupError) {
            logger.debug('Cleanup error (ignored):', cleanupError);
          }
        }, 5000);

        // Small delay between copies
        if (i < copies - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const totalTime = Date.now() - startTime;
      logger.info(`✅ ULTRA-CONSERVATIVE: ${copies} copies in ${totalTime}ms (${Math.round(totalTime / copies)}ms/copy)`);

    } catch (error: any) {
      logger.error(`❌ Ultra-conservative method failed: ${error.message}`);
      logger.error('Error stack:', error.stack);

      // Log browser and page state for debugging
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
      // Always close the page with extensive error handling
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

  // 3. Simplified browser health check
  private startBrowserHealthCheck(): void {
    this.browserHealthInterval = setInterval(async () => {
      try {
        if (!this.browser || !this.browser.connected) {
          logger.warn('Browser disconnected, reinitializing...');
          await this.reinitializeBrowserConservative();
          return;
        }

        // Just check basic browser health
        const pages = await this.browser.pages();
        logger.debug(`Browser health check: ${pages.length} pages`);

        // Conservative cleanup - only if we have way too many pages
        if (pages.length > 20) {
          logger.warn(`Too many pages (${pages.length}), cleaning up excess...`);
          const pagesToClose = pages.slice(5); // Keep first 5 pages

          for (const page of pagesToClose) {
            try {
              await page.close();
            } catch (closeError) {
              logger.debug('Error closing excess page:', closeError);
            }
          }
        }

      } catch (error: any) {
        logger.error('Browser health check failed:', error);
        // Don't automatically reinitialize on health check failure
        // Let it try to recover naturally
      }
    }, 60000); // Check every minute
  }

  // 4. Conservative browser reinitialization
  private async reinitializeBrowserConservative(): Promise<void> {
    logger.info('🔄 Reinitializing browser (ultra-conservative mode)...');

    try {
      // Close old browser with timeout
      if (this.browser) {
        try {
          const closePromise = this.browser.close();
          await Promise.race([
            closePromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Browser close timeout')), 10000))
          ]);
          logger.debug('Old browser closed successfully');
        } catch (error: any) {
          logger.warn('Error/timeout closing old browser:', error.message);
          // Continue anyway
        }
      }

      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Reinitialize browser
      await this.initializePuppeteer();

      logger.info('✅ Browser reinitialized successfully (ultra-conservative mode)');
    } catch (error: any) {
      logger.error('❌ Failed to reinitialize browser (ultra-conservative mode):', error);
      throw error;
    }
  }

  // 5. Updated getBrowserStatus
  public getBrowserStatus(): { available: boolean, error?: string, stats?: any; } {
    try {
      if (!this.browser) {
        return { available: false, error: 'Browser not initialized' };
      }

      if (!this.browser.connected) {
        return { available: false, error: 'Browser disconnected' };
      }

      return {
        available: true,
        stats: {
          mode: 'ultra-conservative',
          pagePoolEnabled: false,
          memoryUsage: process.memoryUsage(),
          browserConnected: this.browser.connected
        }
      };
    } catch (error: any) {
      return { available: false, error: error.message };
    }
  }

  // 6. Alternative: Test with wkhtmltopdf primary method temporarily
  // Add this method to test if the issue is Puppeteer-specific
  public async printLabelWkhtmltopdfOnly(printerName: string, htmlContent: string, metadata: Partial<PrintMetadata>): Promise<void> {
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

      // Use wkhtmltopdf only for testing
      if (this.wkhtmltopdfPath) {
        logger.info(`=== WKHTMLTOPDF ONLY TEST ===`);
        await this.printWithWkhtmltopdf(enhancedHtml, printerName, copies, metadata);
      } else {
        throw new Error('wkhtmltopdf not available');
      }

      const totalTime = Date.now() - totalStartTime;
      logger.info(`📊 WKHTMLTOPDF ONLY: ${copies} copies completed in ${totalTime}ms`);

      logger.info(`Successfully printed ${copies} copies to ${printerName} (wkhtmltopdf only)`);
    } catch (error: any) {
      logger.error(`Print failed for printer ${printerName} (wkhtmltopdf only):`, error);
      throw error;
    }
  }




  public destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    if (this.browserHealthInterval) {
      clearInterval(this.browserHealthInterval);
    }

    // Clean up page pool
    this.pagePool.forEach(page => {
      page.close().catch(() => { });
    });
    this.pagePool = [];

    if (this.browser) {
      this.browser.close().catch(error => {
        logger.error('Error closing Puppeteer browser:', error);
      });
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
        return html.replace(/<html[^>]*>/i, `$&${printCss}`); // Fixed this line
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

  public getPerformanceStats(): any {
    return {
      browserConnected: this.browser?.connected || false,
      pagePoolSize: this.pagePool.length,
      maxPoolSize: this.maxPoolSize,
      activeSemaphore: this.pagePoolSemaphore,
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

      const base64Html = Buffer.from(testHtml).toString('base64');
      await this.printLabel(printerName, base64Html, { copies: 1 });
      return true;
    } catch (error) {
      logger.error(`Test print failed for ${printerName}:`, error);
      return false;
    }
  }
}