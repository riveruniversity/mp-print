# High-Performance Print Server

A robust Node.js/TypeScript print server designed for Windows Server environments, optimized to handle thousands of label print jobs across multiple printers with high throughput and reliability.

## Features

- **High Performance**: Multi-worker clustering and concurrent job processing
- **Queue Management**: Priority-based job queue with automatic retry logic
- **Printer Monitoring**: Real-time printer health checks and status monitoring
- **Windows Integration**: Native Windows printer discovery and printing
- **Type Safety**: Full TypeScript implementation with strict typing
- **Production Ready**: Windows Service installation, logging, and monitoring

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   API Layer     │────│   Print Service  │────│ Printer Service │
│ (Express/Routes)│    │   (Orchestrator) │    │ (Win Integration)│
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                        ┌──────────────────┐
                        │  Queue Service   │
                        │ (Priority Queue) │
                        └──────────────────┘
```

## Quick Start

### Prerequisites

- **Node.js** 18+ 
- **Windows Server** 2016+ or Windows 10+
- **PowerShell** 5.1+
- **Administrator privileges** for service installation

### Installation

1. **Clone and setup project**:
   ```bash
   git clone <repository-url>
   cd high-performance-print-server
   npm install
   ```

2. **Build the project**:
   ```bash
   npm run build
   ```

3. **Install as Windows Service** (run as Administrator):
   ```powershell
   .\scripts\install-service.ps1
   ```

4. **Verify installation**:
   ```bash
   # Check service status
   Get-Service PrintServer
   
   # Test health endpoint
   curl http://localhost:3000/health
   ```

## Configuration

Environment variables can be set in the system or through the service configuration:

```bash
# Server Configuration
PORT=3000
HOST=0.0.0.0
WORKERS=4

# Security
ALLOWED_ORIGINS=http://localhost:3000,https://your-domain.com

# Logging
LOG_LEVEL=info
```

## API Reference

### Submit Print Job

```http
POST /api/print/submit
Content-Type: application/json

{
  "printerName": "HP_LaserJet_Pro",
  "htmlContent": "PGh0bWw+PGJvZHk+PGgxPkxhYmVsPC9oMT48L2JvZHk+PC9odG1sPg==",
  "metadata": {
    "ageGroup": "adult",
    "priority": "high",
    "copies": 2,
    "paperSize": "A4",
    "orientation": "portrait"
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000"
  },
  "message": "Print job submitted successfully"
}
```

### Check Job Status

```http
GET /api/print/status/{jobId}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "job": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "status": "completed",
      "request": { /* original request */ },
      "startTime": 1640995200000,
      "endTime": 1640995205000
    }
  }
}
```

### Get Server Metrics

```http
GET /api/print/metrics
```

**Response:**
```json
{
  "success": true,
  "data": {
    "metrics": {
      "totalJobs": 1250,
      "completedJobs": 1200,
      "failedJobs": 15,
      "averageProcessingTime": 2500,
      "queueLength": 35,
      "activePrinters": 47
    }
  }
}
```

### Get Printer Status

```http
GET /api/print/printers
```

**Response:**
```json
{
  "success": true,
  "data": {
    "printers": [
      {
        "name": "HP_LaserJet_Pro",
        "status": "online",
        "jobsInQueue": 3,
        "lastJobTime": 1640995200000,
        "errorCount": 0
      }
    ]
  }
}
```

## Performance Specifications

- **Concurrent Jobs**: Up to 50 simultaneous print jobs
- **Queue Capacity**: 10,000 jobs in memory
- **Batch Processing**: Configurable batch sizes (default: 10)
- **Retry Logic**: 3 automatic retries with exponential backoff
- **Throughput**: Designed for thousands of jobs per hour
- **Memory Management**: Automatic cleanup of completed jobs

## Service Management

### Start/Stop/Restart Service
```powershell
# Start service
net start PrintServer

# Stop service
net stop PrintServer

# Restart service
net stop PrintServer && net start PrintServer

# Check status
Get-Service PrintServer
```

### View Logs
```powershell
# Service logs location
Get-Content "C:\PrintServer\logs\combined.log" -Tail 50

# Error logs
Get-Content "C:\PrintServer\logs\error.log" -Tail 20
```

### Uninstall Service
```powershell
# Run as Administrator
.\scripts\uninstall-service.ps1
```

## Development

### Local Development
```bash
# Development mode with hot reload
npm run dev

# Run tests
npm test

# Build TypeScript
npm run build

# Clean build directory
npm run clean
```

### Project Structure
```
src/
├── config/          # Configuration management
├── middleware/      # Express middleware
├── routes/          # API route handlers
├── services/        # Core business logic
├── types/           # TypeScript type definitions
├── utils/           # Utility functions
└── server.ts        # Main server entry point

scripts/             # PowerShell deployment scripts
logs/               # Application logs
dist/               # Compiled JavaScript (build output)
```

## Troubleshooting

### Common Issues

**Service won't start:**
```powershell
# Check if port is in use
netstat -ano | findstr :3000

# Check service logs
Get-EventLog -LogName Application -Source "PrintServer" -Newest 10
```

**Printer not detected:**
```powershell
# List all printers
Get-Printer | Select-Object Name, PrinterStatus

# Check printer status
Get-Printer -Name "YourPrinterName"
```

**Performance issues:**
- Check server metrics: `GET /api/print/metrics`
- Monitor queue length and processing times
- Verify adequate system resources (CPU, memory)
- Consider increasing worker count in production

### Log Levels
- `error`: Critical errors and failures
- `warn`: Warning conditions
- `info`: General information (default)
- `debug`: Detailed debugging information

## Security Considerations

- **Rate Limiting**: 1000 requests per 15-minute window
- **CORS**: Configurable allowed origins
- **Input Validation**: Strict validation using Joi schemas
- **Base64 Encoding**: HTML content must be base64 encoded
- **Service Account**: Runs under Windows service account

## License

[Your License Here]

## Support

For issues and support:
1. Check the logs in `logs/` directory
2. Review this documentation
3. Check Windows Event Logs for service-related issues
4. Verify printer connectivity and drivers