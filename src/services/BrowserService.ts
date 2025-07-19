import puppeteer, { Browser, Page } from 'puppeteer';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import logger from '../utils/logger';



const execAsync = promisify(exec);

export class BrowserService {

  public browser?: Browser;
  public wkhtmltopdfPath?: string;
  private chromePath: string | undefined;

  private browserHealthInterval?: ReturnType<typeof setInterval>;



  public async initialize(): Promise<void> {
    await this.findWkhtmltopdf();
    await this.initializePuppeteer();

    this.startBrowserHealthCheck();
  }


  // Puppeteer implementation 
  private async initializePuppeteer(): Promise<void> {
    try {
      const chromePaths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      ];


      for (const path of chromePaths) {
        if (require('fs').existsSync(path)) {
          this.chromePath = path;
          break;
        }
      }

      if (!this.chromePath) {
        throw new Error('Chrome not found in system directories');
      }

      this.browser = await puppeteer.launch({
        executablePath: this.chromePath,
        headless: true,
        args: [
          '--headless=new',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--disable-features=TranslateUI',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-accelerated-2d-canvas',
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
          '--disable-javascript',
          // Memory optimizations
          '--memory-pressure-off',
        ],
        timeout: 10000,
        protocolTimeout: 120000, // 2 minutes protocol timeout
        defaultViewport: {
          width: 980,
          height: 600, // Standard size, not too small
          deviceScaleFactor: 1
        }
      });

      logger.info('Puppeteer browser initialized');
    } catch (error: any) {
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


  // browser health check
  private startBrowserHealthCheck(): void {
    this.browserHealthInterval = setInterval(async () => {
      if (!this.browser?.connected) {
        logger.warn('Browser disconnected, marking for reinitialization');
        this.browser = undefined; // Let next print job reinitialize
      }
    }, 60000);
  }


  // Conservative browser reinitialization
  public async reinitializeBrowser(): Promise<void> {
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
          browserConnected: this.browser.connected
        }
      };
    } catch (error: any) {
      return { available: false, error: error.message };
    }
  }


  public getPerformanceStats(): any {
    return {
      browserConnected: this.browser?.connected || false,
      memoryUsage: process.memoryUsage(),
    };
  }


  public destroy(): void {

    if (this.browserHealthInterval) {
      clearInterval(this.browserHealthInterval);
    }

    if (this.browser) {
      this.browser.close().catch(error => {
        logger.error('Error closing Puppeteer browser:', error);
      });
    }
  }

}