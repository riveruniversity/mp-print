# PowerShell script to install Print Server as Windows service
param(
    [Parameter(Mandatory=$false)]
    [string]$ServicePath = "C:\PrintServer",
    
    [Parameter(Mandatory=$false)]
    [string]$NodePath = "C:\Program Files\nodejs\node.exe"
)

# Configuration
$ServiceName = "PrintServer"
$ServiceDisplayName = "High Performance Print Server"
$ServiceDescription = "Node.js print server for label printing with TypeScript"
$ScriptPath = "$ServicePath\dist\server.js"

# Check if running as Administrator
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator. Please run PowerShell as Administrator and try again."
    exit 1
}

# Check if Node.js exists
if (-not (Test-Path $NodePath)) {
    Write-Error "Node.js not found at $NodePath. Please install Node.js or update the NodePath parameter."
    exit 1
}

# Check if service path exists
if (-not (Test-Path $ServicePath)) {
    Write-Error "Service path $ServicePath does not exist. Please ensure the application is deployed."
    exit 1
}

# Check if compiled JavaScript exists
if (-not (Test-Path $ScriptPath)) {
    Write-Error "Compiled JavaScript not found at $ScriptPath. Please run 'npm run build' first."
    exit 1
}

Write-Host "Installing Print Server as Windows Service..." -ForegroundColor Green

try {
    # Install node-windows globally if not already installed
    Write-Host "Checking for node-windows package..." -ForegroundColor Yellow
    $nodeWindowsCheck = npm list -g node-windows 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Installing node-windows globally..." -ForegroundColor Yellow
        npm install -g node-windows
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install node-windows"
        }
    }

    # Create service installation script
    $serviceScript = @"
var Service = require('node-windows').Service;

// Create a new service object
var svc = new Service({
  name: '$ServiceName',
  description: '$ServiceDescription',
  script: '$ScriptPath',
  nodeOptions: [
    '--harmony',
    '--max_old_space_size=4096'
  ],
  env: [
    {
      name: 'NODE_ENV',
      value: 'production'
    },
    {
      name: 'PORT',
      value: '3000'
    }
  ],
  workingDirectory: '$ServicePath',
  allowServiceLogon: true
});

// Listen for the "install" event, which indicates the
// process is available as a service.
svc.on('install', function(){
  console.log('Service installed successfully');
  svc.start();
});

svc.on('alreadyinstalled', function(){
  console.log('Service is already installed');
});

svc.on('start', function(){
  console.log('Service started successfully');
});

svc.on('error', function(err){
  console.error('Service error:', err);
});

// Install the service
svc.install();
"@

    # Write service script to temporary file
    $tempScriptPath = "$ServicePath\install-service-temp.js"
    $serviceScript | Out-File -FilePath $tempScriptPath -Encoding utf8

    # Run the service installation
    Write-Host "Installing service..." -ForegroundColor Yellow
    Set-Location $ServicePath
    & $NodePath $tempScriptPath

    # Wait for service installation
    Start-Sleep -Seconds 5

    # Clean up temporary file
    Remove-Item $tempScriptPath -Force -ErrorAction SilentlyContinue

    # Verify service installation
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service) {
        Write-Host "Service '$ServiceDisplayName' installed successfully!" -ForegroundColor Green
        Write-Host "Service Status: $($service.Status)" -ForegroundColor Cyan
        
        if ($service.Status -eq "Running") {
            Write-Host "Print server is now running on http://localhost:3000" -ForegroundColor Green
            Write-Host "Health check: http://localhost:3000/health" -ForegroundColor Cyan
        }
    } else {
        throw "Service installation verification failed"
    }

    # Display service management commands
    Write-Host "`nService Management Commands:" -ForegroundColor Yellow
    Write-Host "  Start:   net start $ServiceName" -ForegroundColor White
    Write-Host "  Stop:    net stop $ServiceName" -ForegroundColor White
    Write-Host "  Restart: net stop $ServiceName && net start $ServiceName" -ForegroundColor White
    Write-Host "  Status:  Get-Service $ServiceName" -ForegroundColor White

} catch {
    Write-Error "Failed to install service: $_"
    exit 1
}

Write-Host "`nInstallation completed successfully!" -ForegroundColor Green