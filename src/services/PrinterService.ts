import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { PrinterStatus, PrinterStatusType, WindowsPrinter } from '../types';
import { config } from '../config';
import logger from '../utils/logger';

const execAsync = promisify(exec);

export class PrinterService {
  private printers: Map<string, PrinterStatus> = new Map();
  private healthCheckInterval?: ReturnType<typeof setInterval>;
  private edgePath?: string;
  private wkhtmltopdfPath?: string;

  public async initialize(): Promise<void> {
    await this.findEdgePath();
    await this.findWkhtmltopdf();
    await this.discoverPrinters();
    this.startHealthCheck();
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
          logger.info('Found wkhtmltopdf in system PATH');
          return;
        } else if (existsSync(path)) {
          this.wkhtmltopdfPath = path;
          logger.info(`Found wkhtmltopdf at: ${path}`);
          return;
        }
      } catch (error) {
        // Continue to next path
      }
    }

    logger.warn('wkhtmltopdf not found - will use Edge as fallback');
  }

  private async findEdgePath(): Promise<void> {
    const possiblePaths = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe'
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        this.edgePath = path;
        logger.info(`Found Microsoft Edge at: ${path}`);
        return;
      }
    }

    // Try to find Edge via PowerShell
    try {
      const command = `powershell -Command "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe' | Select-Object '(default)' | ForEach-Object { $_.'(default)' }"`;
      const { stdout } = await execAsync(command);
      if (stdout.trim()) {
        this.edgePath = stdout.trim();
        logger.info(`Found Microsoft Edge via registry: ${this.edgePath}`);
        return;
      }
    } catch (error) {
      logger.warn('Could not find Edge via registry');
    }

    // Fallback to system PATH
    this.edgePath = 'msedge.exe';
    logger.warn('Using msedge.exe from system PATH - ensure Microsoft Edge is in PATH');
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
          status: this.mapPrinterStatus(printer.PrinterStatus),
          jobsInQueue: 0,
          errorCount: 0
        });
      }

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

  public async printLabel(printerName: string, htmlContent: string, copies: number = 1): Promise<void> {
    const printer: PrinterStatus | undefined = this.printers.get(printerName);
    if (!printer || printer.status !== 'online') {
      throw new Error(`Printer ${printerName} is not available`);
    }

    try {
      // Decode base64 HTML content
      const decodedHtml: string = Buffer.from(htmlContent, 'base64').toString('utf8');

      // Create enhanced HTML with print-specific CSS
      const enhancedHtml = this.enhanceHtmlForPrinting(decodedHtml);

      // Create temporary HTML file
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substr(2, 9);
      const tempFile: string = `temp_${timestamp}_${randomId}.html`;
      const fullTempPath = join(process.cwd(), tempFile);
      
      writeFileSync(fullTempPath, enhancedHtml, 'utf8');

      const totalStartTime = Date.now();

      // Try lightweight method first, fallback to Edge
      if (this.wkhtmltopdfPath) {
        try {
          logger.info(`=== LIGHTWEIGHT WKHTMLTOPDF METHOD ===`);
          const lightweightStartTime = Date.now();
          
          for (let i: number = 0; i < copies; i++) {
            await this.printWithWkhtmltopdf(fullTempPath, printerName, i + 1, copies);
          }
          
          const lightweightTime = Date.now() - lightweightStartTime;
          logger.info(`✅ WKHTMLTOPDF: ${copies} copies printed in ${lightweightTime}ms (avg: ${Math.round(lightweightTime/copies)}ms per copy)`);
        } catch (error) {
          logger.warn(`❌ WKHTMLTOPDF FAILED: ${error}, falling back to Edge`);
          await this.fallbackToEdge(fullTempPath, printerName, copies);
        }
      } else {
        // Use Edge method
        await this.fallbackToEdge(fullTempPath, printerName, copies);
      }

      const totalTime = Date.now() - totalStartTime;
      logger.info(`📊 TOTAL PRINT JOB: ${copies} copies completed in ${totalTime}ms`);

      // Clean up temporary file
      setTimeout(() => {
        try {
          if (existsSync(fullTempPath)) {
            unlinkSync(fullTempPath);
          }
        } catch (cleanupError) {
          logger.warn(`Failed to cleanup temp file ${tempFile}:`, cleanupError);
        }
      }, 2000);

      logger.info(`Successfully printed ${copies} copies to ${printerName}`);
    } catch (error: any) {
      logger.error(`Print failed for printer ${printerName}:`, error);
      throw error;
    }
  }

  private async printWithWkhtmltopdf(htmlFilePath: string, printerName: string, copyNumber: number, totalCopies: number): Promise<void> {
    const startTime = Date.now();

    try {
      // Create PDF from HTML using wkhtmltopdf
      const pdfFile = htmlFilePath.replace('.html', '.pdf');
      
      const convertCommand = `"${this.wkhtmltopdfPath}" --page-size A4 --margin-top 0 --margin-bottom 0 --margin-left 0 --margin-right 0 --disable-smart-shrinking --print-media-type "${htmlFilePath}" "${pdfFile}"`;
      
      await execAsync(convertCommand, { timeout: 5000 });

      // Print PDF using PDFtoPrinter.exe
      const printCommand = `PDFtoPrinter.exe "${pdfFile}" "${printerName}"`;
      
      await execAsync(printCommand, { timeout: 5000 });

      // Clean up PDF file
      setTimeout(() => {
        try {
          if (existsSync(pdfFile)) {
            unlinkSync(pdfFile);
          }
        } catch (cleanupError) {
          logger.warn(`Failed to cleanup PDF file:`, cleanupError);
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

  private async fallbackToEdge(htmlFilePath: string, printerName: string, copies: number): Promise<void> {
    if (!this.edgePath) {
      throw new Error('Neither wkhtmltopdf nor Edge is available');
    }

    logger.info(`=== EDGE FALLBACK METHOD ===`);
    const edgeStartTime = Date.now();
    
    const fileUrl = `file:///${htmlFilePath.replace(/\\/g, '/')}`;
    
    for (let i: number = 0; i < copies; i++) {
      await this.printWithEdge(fileUrl, printerName, i + 1, copies);
    }
    
    const edgeTime = Date.now() - edgeStartTime;
    logger.info(`✅ EDGE FALLBACK: ${copies} copies printed in ${edgeTime}ms (avg: ${Math.round(edgeTime/copies)}ms per copy)`);
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

  private async printWithEdge(fileUrl: string, printerName: string, copyNumber: number, totalCopies: number): Promise<void> {
    const timeout = config.printing.ieTimeout || 10000;
    
    const escapedEdgePath = this.edgePath!.replace(/\\/g, '\\\\');
    const timeoutSeconds = Math.floor(timeout / 1000);
    
    const powershellCommand = `
      $process = Start-Process -FilePath '${escapedEdgePath}' -ArgumentList '--headless', '--disable-gpu', '--disable-web-security', '--no-sandbox', '--print-to-printer=${printerName}', '${fileUrl}' -PassThru -WindowStyle Hidden;
      try {
        $process | Wait-Process -Timeout ${timeoutSeconds};
        Write-Output 'COMPLETED'
      } catch {
        $process | Stop-Process -Force -ErrorAction SilentlyContinue;
        Write-Output 'TIMEOUT'
      }
    `.replace(/\s+/g, ' ').trim();

    try {
      logger.debug(`Printing copy ${copyNumber}/${totalCopies} to ${printerName}`);
      
      const { stdout, stderr } = await execAsync(`powershell -Command "${powershellCommand}"`, {
        timeout: timeout + 2000,
        windowsHide: true
      });

      if (stdout.includes('TIMEOUT')) {
        logger.warn(`Edge process timeout for copy ${copyNumber}, but print job may have been submitted`);
      } else if (stdout.includes('COMPLETED')) {
        logger.debug(`Edge process completed for copy ${copyNumber}`);
      }

      if (copyNumber < totalCopies) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }

    } catch (error: any) {
      if (error.code === 'TIMEOUT') {
        logger.warn(`PowerShell timeout for copy ${copyNumber} after ${timeout}ms`);
      } else {
        throw new Error(`Print failed for copy ${copyNumber}: ${error.message}`);
      }
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
      await this.printLabel(printerName, base64Html, 1);
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
  }
}