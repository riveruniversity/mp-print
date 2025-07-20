// src/workers/printerWorker.ts - Non-blocking printer operations
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { exec } from 'child_process';
import { promisify } from 'util';
import { WindowsPrinter, PrinterStatus, PrinterStatusType } from '../types';

const execAsync = promisify(exec);

interface WorkerMessage {
  type: 'DISCOVER_PRINTERS' | 'CHECK_PRINTER_HEALTH' | 'SEND_ZPL_COMMANDS' | 'SHUTDOWN';
  data?: any;
  requestId: string;
}

interface WorkerResponse {
  type: 'SUCCESS' | 'ERROR' | 'TIMEOUT';
  data?: any;
  requestId: string;
  error?: string;
}

if (!isMainThread && parentPort) {
  // Worker thread implementation
  parentPort.on('message', async (message: WorkerMessage) => {
    const { type, data, requestId } = message;
    
    try {
      let result: any;
      
      switch (type) {
        case 'DISCOVER_PRINTERS':
          result = await discoverPrinters();
          break;
          
        case 'CHECK_PRINTER_HEALTH':
          result = await checkPrinterHealth(data.printerName);
          break;
          
        case 'SEND_ZPL_COMMANDS':
          result = await sendZplCommands(data.printerName, data.commands, data.tempFilePath);
          break;
          
        case 'SHUTDOWN':
          process.exit(0);
          break;
          
        default:
          throw new Error(`Unknown worker message type: ${type}`);
      }
      
      const response: WorkerResponse = {
        type: 'SUCCESS',
        data: result,
        requestId
      };
      
      parentPort!.postMessage(response);
      
    } catch (error: any) {
      const response: WorkerResponse = {
        type: 'ERROR',
        error: error.message,
        requestId
      };
      
      parentPort!.postMessage(response);
    }
  });
  
  // Worker functions
  async function discoverPrinters(): Promise<PrinterStatus[]> {
    const command = `powershell -Command "Get-Printer | Select-Object PrinterStatus, Name, DriverName, PortName | ConvertTo-Json -Compress"`;
    
    const { stdout } = await execAsync(command, { 
      timeout: 5000,
      killSignal: 'SIGKILL' // Force kill if hanging
    });
    
    if (!stdout || stdout.trim() === '' || stdout.trim() === 'null') {
      return [];
    }
    
    const printers: WindowsPrinter | WindowsPrinter[] = JSON.parse(stdout);
    const printerArray: WindowsPrinter[] = Array.isArray(printers) ? printers : [printers];
    
    return printerArray.map(printer => ({
      name: printer.Name,
      port: printer.PortName,
      driver: printer.DriverName,
      status: mapPrinterStatus(printer.PrinterStatus),
      jobsInQueue: 0,
      errorCount: 0
    }));
  }
  
  async function checkPrinterHealth(printerName: string): Promise<PrinterStatusType> {
    const command = `powershell -Command "try { Get-Printer -Name '${printerName}' -ErrorAction Stop | Select-Object PrinterStatus | ConvertTo-Json -Compress } catch { Write-Output 'ERROR' }"`;
    
    const { stdout } = await execAsync(command, { 
      timeout: 3000,
      killSignal: 'SIGKILL'
    });
    
    if (!stdout || stdout.trim() === 'ERROR' || stdout.trim() === '') {
      return 'offline';
    }
    
    try {
      const result = JSON.parse(stdout);
      return mapPrinterStatus(result.PrinterStatus);
    } catch {
      return 'offline';
    }
  }
  
  async function sendZplCommands(printerName: string, commands: string, tempFilePath: string): Promise<boolean> {
    const copyCommand = `copy "${tempFilePath}" "${printerName}"`;
    
    try {
      await execAsync(copyCommand, { 
        timeout: 8000,
        killSignal: 'SIGKILL'
      });
      return true;
    } catch (error) {
      return false;
    }
  }
  
  function mapPrinterStatus(status: number): PrinterStatusType {
    switch (status) {
      case 0: return 'online';
      case 1: return 'offline';
      case 2: return 'error';
      default: return 'offline';
    }
  }
}

// Main thread wrapper class
export class PrinterWorkerPool {
  private workers: Worker[] = [];
  private workerIndex: number = 0;
  private requestCounter: number = 0;
  private pendingRequests: Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout; }> = new Map();
  
  constructor(private poolSize: number = 2) {
    this.initializeWorkers();
  }
  
  private initializeWorkers(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(__filename);
      
      worker.on('message', (response: WorkerResponse) => {
        const pending = this.pendingRequests.get(response.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(response.requestId);
          
          if (response.type === 'SUCCESS') {
            pending.resolve(response.data);
          } else {
            pending.reject(new Error(response.error || 'Worker operation failed'));
          }
        }
      });
      
      worker.on('error', (error) => {
        console.error(`Worker ${i} error:`, error);
        this.replaceWorker(i);
      });
      
      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Worker ${i} exited with code ${code}`);
          this.replaceWorker(i);
        }
      });
      
      this.workers[i] = worker;
    }
  }
  
  private replaceWorker(index: number): void {
    try {
      this.workers[index]?.terminate();
    } catch (error) {
      // Ignore termination errors
    }
    
    const newWorker = new Worker(__filename);
    this.workers[index] = newWorker;
  }
  
  private getNextWorker(): Worker {
    const worker = this.workers[this.workerIndex];
    this.workerIndex = (this.workerIndex + 1) % this.workers.length;
    return worker;
  }
  
  private async executeWorkerTask<T>(
    type: WorkerMessage['type'], 
    data?: any, 
    timeoutMs: number = 10000
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const requestId = `req_${++this.requestCounter}_${Date.now()}`;
      const worker = this.getNextWorker();
      
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Worker operation timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      
      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      
      const message: WorkerMessage = {
        type,
        data,
        requestId
      };
      
      worker.postMessage(message);
    });
  }
  
  public async discoverPrinters(): Promise<PrinterStatus[]> {
    try {
      return await this.executeWorkerTask<PrinterStatus[]>('DISCOVER_PRINTERS', undefined, 8000);
    } catch (error) {
      console.error('Printer discovery failed:', error);
      return [];
    }
  }
  
  public async checkPrinterHealth(printerName: string): Promise<PrinterStatusType> {
    try {
      return await this.executeWorkerTask<PrinterStatusType>('CHECK_PRINTER_HEALTH', { printerName }, 5000);
    } catch (error) {
      console.error(`Health check failed for ${printerName}:`, error);
      return 'error';
    }
  }
  
  public async sendZplCommands(printerName: string, commands: string, tempFilePath: string): Promise<boolean> {
    try {
      return await this.executeWorkerTask<boolean>('SEND_ZPL_COMMANDS', { 
        printerName, 
        commands, 
        tempFilePath 
      }, 10000);
    } catch (error) {
      console.error(`ZPL command failed for ${printerName}:`, error);
      return false;
    }
  }
  
  public destroy(): void {
    // Clear all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Worker pool shutting down'));
    }
    this.pendingRequests.clear();
    
    // Terminate all workers
    for (const worker of this.workers) {
      try {
        worker.postMessage({ type: 'SHUTDOWN', requestId: 'shutdown' });
        worker.terminate();
      } catch (error) {
        // Ignore termination errors
      }
    }
    
    this.workers = [];
  }
}