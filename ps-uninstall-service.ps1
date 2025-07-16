# PowerShell script to uninstall Print Server Windows service
param(
    [Parameter(Mandatory=$false)]
    [string]$ServicePath = "C:\PrintServer",
    
    [Parameter(Mandatory=$false)]
    [string]$NodePath = "C:\Program Files\nodejs\node.exe"
)

# Configuration
$ServiceName = "PrintServer"
$ServiceDisplayName = "High Performance Print Server"

# Check if running as Administrator
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Error "This script must be run as Administrator. Please run PowerShell as Administrator and try again."
    exit 1
}

Write-Host "Uninstalling Print Server Windows Service..." -ForegroundColor Yellow

try {
    # Check if service exists
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) {
        Write-Host "Service '$ServiceName' is not installed." -ForegroundColor Green
        exit 0
    }

    Write-Host "Found service: $($service.DisplayName)" -ForegroundColor Cyan
    Write-Host "Current status: $($service.Status)" -ForegroundColor Cyan

    # Stop service if running
    if ($service.Status -eq "Running") {
        Write-Host "Stopping service..." -ForegroundColor Yellow
        Stop-Service -Name $ServiceName -Force
        Start-Sleep -Seconds 3
    }

    # Create uninstall script
    $uninstallScript = @"
var Service = require('node-windows').Service;

// Create a new service object
var svc = new Service({
  name: '$ServiceName',
  script: 'dummy.js' // Script path not needed for uninstall
});

// Listen for the "uninstall" event
svc.on('uninstall', function(){
  console.log('Service uninstalled successfully');
});

svc.on('doesnotexist', function(){
  console.log('Service does not exist');
});

svc.on('error', function(err){
  console.error('Uninstall error:', err);
});

// Uninstall the service
svc.uninstall();
"@

    # Write uninstall script to temporary file
    $tempScriptPath = "$ServicePath\uninstall-service-temp.js"
    
    # Ensure service path exists
    if (-not (Test-Path $ServicePath)) {
        New-Item -ItemType Directory -Path $ServicePath -Force | Out-Null
    }
    
    $uninstallScript | Out-File -FilePath $tempScriptPath -Encoding utf8

    # Run the service uninstallation
    Write-Host "Removing service..." -ForegroundColor Yellow
    Set-Location $ServicePath
    & $NodePath $tempScriptPath

    # Wait for service removal
    Start-Sleep -Seconds 5

    # Clean up temporary file
    Remove-Item $tempScriptPath -Force -ErrorAction SilentlyContinue

    # Verify service removal
    $serviceCheck = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $serviceCheck) {
        Write-Host "Service '$ServiceDisplayName' uninstalled successfully!" -ForegroundColor Green
    } else {
        Write-Warning "Service may still exist. You might need to restart the system or manually remove it."
    }

} catch {
    Write-Error "Failed to uninstall service: $_"
    
    # Try alternative removal method
    Write-Host "Attempting alternative removal method..." -ForegroundColor Yellow
    try {
        sc.exe delete $ServiceName
        Write-Host "Service removed using sc.exe" -ForegroundColor Green
    } catch {
        Write-Error "Alternative removal also failed: $_"
        exit 1
    }
}

Write-Host "Uninstallation completed!" -ForegroundColor Green