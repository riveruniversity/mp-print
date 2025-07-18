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
          '--max_old_space_size=4096',
          // Performance optimizations
          '--single-process', // Use single process for better resource management
        ],
        // Keep browser alive longer
        timeout: 0,
        protocolTimeout: 60000,
      });

      // Keep browser alive with a dummy page
      const keepAlivePage = await this.browser.newPage();
      await keepAlivePage.goto('data:text/html,<html><body>Keep Alive</body></html>');
      
      logger.info('Puppeteer browser initialized successfully with optimizations');
    } catch (error) {
      logger.error('Failed to initialize Puppeteer:', error);
      throw new Error('Puppeteer initialization failed');
    }
  }

  private async initializePagePool(): Promise<void> {
    if (!this.browser) return;

    try {
      // Pre-create pages for the pool
      for (let i = 0; i < this.maxPoolSize; i++) {
        const page = await this.createOptimizedPage();
        this.pagePool.push(page);
      }
      logger.info(`Initialized page pool with ${this.maxPoolSize} pages`);
    } catch (error) {
      logger.error('Failed to initialize page pool:', error);
    }
  }

  private async createOptimizedPage(): Promise<Page> {
    if (!this.browser) throw new Error('Browser not initialized');

    const page = await this.browser.newPage();
    
    // Optimize page settings
    await page.setDefaultTimeout(10000);
    await page.setDefaultNavigationTimeout(10000);
    
    // Disable unnecessary features for better performance
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      // Block unnecessary resources
      const resourceType = request.resourceType();
      if (['image', 'stylesheet', 'font', 'script'].includes(resourceType)) {
        // Allow only essential resources for printing
        if (resourceType === 'stylesheet' || resourceType === 'font') {
          request.continue();
        } else {
          request.abort();
        }
      } else {
        request.continue();
      }
    });

    // Set print-optimized viewport
    await page.setViewport({
      width: 1000,
      height: 1000,
      deviceScaleFactor: 1
    });

    return page;
  }

  private async getPageFromPool(): Promise<Page> {
    // Wait for available page using semaphore pattern
    while (this.pagePoolSemaphore >= this.maxPoolSize) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.pagePoolSemaphore++;

    if (this.pagePool.length > 0) {
      const page = this.pagePool.pop()!;
      try {
        // Reset page state
        await page.goto('data:text/html,<html><body></body></html>', { waitUntil: 'domcontentloaded' });
        return page;
      } catch (error) {
        logger.warn('Page from pool is unusable, creating new one:', error);
        try {
          await page.close();
        } catch (closeError) {
          // Ignore close errors
        }
      }
    }

    // Create new page if pool is empty or page is unusable
    return await this.createOptimizedPage();
  }

  private async returnPageToPool(page: Page): Promise<void> {
    this.pagePoolSemaphore--;

    try {
      // Clean up page state but keep it alive
      const pages = await page.browser().pages();
      if (pages.length > 10) {
        // If too many pages, close this one
        await page.close();
        return;
      }

      // Reset page for reuse
      await page.goto('data:text/html,<html><body></body></html>', { 
        waitUntil: 'domcontentloaded',
        timeout: 5000 
      });
      
      if (this.pagePool.length < this.maxPoolSize) {
        this.pagePool.push(page);
      } else {
        await page.close();
      }
    } catch (error) {
      logger.warn('Error returning page to pool:', error);
      try {
        await page.close();
      } catch (closeError) {
        // Ignore close errors
      }
    }
  }

  private startBrowserHealthCheck(): void {
    this.browserHealthInterval = setInterval(async () => {
      try {
        if (!this.browser || !this.browser.connected) {
          logger.warn('Browser disconnected, reinitializing...');
          await this.reinitializeBrowser();
          return;
        }

        // Test browser responsiveness
        const pages = await this.browser.pages();
        if (pages.length > 20) {
          logger.warn(`Too many pages open (${pages.length}), cleaning up...`);
          // Close excess pages but keep the first few
          for (let i = 10; i < pages.length; i++) {
            try {
              await pages[i].close();
            } catch (error) {
              // Ignore close errors
            }
          }
        }

        // Memory check
        const memUsage = process.memoryUsage();
        if (memUsage.heapUsed > 1024 * 1024 * 1024) { // 1GB
          logger.warn('High memory usage detected, consider browser restart');
        }

      } catch (error) {
        logger.error('Browser health check failed:', error);
        await this.reinitializeBrowser();
      }
    }, 30000); // Check every 30 seconds
  }

  private async reinitializeBrowser(): Promise<void> {
    logger.info('Reinitializing browser...');
    
    try {
      // Clear page pool
      this.pagePool = [];
      this.pagePoolSemaphore = 0;

      // Close old browser
      if (this.browser) {
        try {
          await this.browser.close();
        } catch (error) {
          logger.warn('Error closing old browser:', error);
        }
      }

      // Wait a moment for cleanup
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Initialize new browser
      await this.initializePuppeteer();
      await this.initializePagePool();
      
      logger.info('Browser reinitialized successfully');
    } catch (error) {
      logger.error('Failed to reinitialize browser:', error);
      throw error;
    }
  }

  public async printWithPuppeteer(html: string, printerName: string, copies: number, metadata: Partial<PrintMetadata>): Promise<void> {
    if (!this.browser || !this.browser.connected) {
      throw new Error('Browser not available');
    }

    logger.info(`=== PUPPETEER PRIMARY METHOD ===`);
    const puppeteerStartTime = Date.now();

    let page: Page | null = null;

    try {
      page = await this.getPageFromPool();

      // Set content with optimized loading
      await page.setContent(html, { 
        waitUntil: 'domcontentloaded', // Faster than 'networkidle0'
        timeout: 10000 
      });

      // Configure PDF options (optimized for labels)
      const pdfOptions = {
        printBackground: true,
        width: '10in',
        height: '1in',
        margin: {
          top: '0mm',
          right: '0mm',
          bottom: '0mm',
          left: '0mm'
        },
        preferCSSPageSize: true,
        format: undefined // Use CSS page size
      };

      // Batch process copies more efficiently
      const batchSize = Math.min(copies, 5); // Process in batches of 5
      const batches = Math.ceil(copies / batchSize);

      for (let batch = 0; batch < batches; batch++) {
        const batchStart = batch * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, copies);
        const batchCopies = batchEnd - batchStart;

        const batchPromises: Promise<void>[] = [];

        for (let i = 0; i < batchCopies; i++) {
          batchPromises.push(this.processSingleCopy(page, pdfOptions, printerName, batchStart + i + 1));
        }

        // Process batch in parallel
        await Promise.all(batchPromises);

        // Small delay between batches
        if (batch < batches - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      const puppeteerTime = Date.now() - puppeteerStartTime;
      logger.info(`✅ PUPPETEER PRIMARY: ${copies} copies printed in ${puppeteerTime}ms (avg: ${Math.round(puppeteerTime / copies)}ms per copy)`);

    } catch (error: any) {
      logger.error(`❌ Puppeteer primary method failed: ${error.message}`);
      throw error;
    } finally {
      if (page) {
        await this.returnPageToPool(page);
      }
    }
  }

  private async processSingleCopy(page: Page, pdfOptions: any, printerName: string, copyNumber: number): Promise<void> {
    const copyStartTime = Date.now();

    try {
      // Generate PDF buffer
      const pdfBuffer = await page.pdf(pdfOptions);

      // Create temporary PDF file with better naming
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 6);
      const pdfFileName = `print_${timestamp}_${randomId}_c${copyNumber}.pdf`;
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

      // Schedule cleanup (async)
      setTimeout(() => {
        try {
          if (existsSync(pdfFilePath)) {
            unlinkSync(pdfFilePath);
          }
        } catch (cleanupError) {
          logger.warn(`Failed to cleanup PDF file:`, cleanupError);
        }
      }, 5000);

      const copyDuration = Date.now() - copyStartTime;
      logger.debug(`⚡ Puppeteer copy ${copyNumber}: ${copyDuration}ms`);

    } catch (error: any) {
      logger.error(`❌ Failed to process copy ${copyNumber}: ${error.message}`);
      throw error;
    }
  }

  public getBrowserStatus(): { available: boolean, error?: string, stats?: any } {
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
          pagePoolSize: this.pagePool.length,
          activeSemaphore: this.pagePoolSemaphore,
          memoryUsage: process.memoryUsage()
        }
      };
    } catch (error: any) {
      return { available: false, error: error.message };
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
      page.close().catch(() => {});
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
        return html.replace(/<html[^>]*>/i, `  // ... rest of your existing methods remain the same${printCss}`);
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
}