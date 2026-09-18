# Collect-AudioInfo.ps1  (v2, reviewed)
# Gathers Windows audio device / driver information for the Minisforum V3 SE
# microphone investigation. READ-ONLY: it never changes any Windows setting.
# Output goes to a "windows-audio-report" folder next to this script.
#
# Run from an *Administrator* PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\Collect-AudioInfo.ps1

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

$Out = Join-Path $PSScriptRoot 'windows-audio-report'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Start-Transcript -Path (Join-Path $Out '99-transcript.txt') -Force | Out-Null

$Log = Join-Path $Out '00-summary.txt'
"Minisforum V3 SE - Windows audio report  $(Get-Date)" | Set-Content $Log
"Computer: $env:COMPUTERNAME   Windows: $([Environment]::OSVersion.VersionString)   Admin: $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrators'))" | Add-Content $Log
"" | Add-Content $Log

function Section($title) { ""; ("=" * 78); $title; ("=" * 78) }

function Get-DevProps($InstanceId) {
    $p = @{}
    try {
        Get-PnpDeviceProperty -InstanceId $InstanceId -ErrorAction SilentlyContinue |
            ForEach-Object { $p[$_.KeyName] = $_.Data }
    } catch {}
    return $p
}

# ---------------------------------------------------------------------------
# 0. Safety net: dump EVERY PnP device (name / class / id / status) to CSV
# ---------------------------------------------------------------------------
Write-Host "[0/7] Listing all PnP devices..."
$all = Get-PnpDevice
$all | Select-Object Status, Class, FriendlyName, InstanceId |
    Export-Csv -NoTypeInformation -Path (Join-Path $Out '00-all-pnp-devices.csv')

# ---------------------------------------------------------------------------
# 1. Every audio-related PnP device, with driver INF, provider, hardware IDs
# ---------------------------------------------------------------------------
Write-Host "[1/7] Audio-related devices + driver details..."
Section "1. Audio-related PnP devices" | Add-Content $Log
$devs = $all | Where-Object {
    ($_.FriendlyName -match 'audio|sound|realtek|microphone|speaker|headphone|\bacp\b|coprocessor|hdaudio|dmic|\bmic\b|nau8|es83|cs42') -or
    ($_.InstanceId  -match 'HDAUDIO|\\ACP|INTELAUDIO|MMDEVAPI|AMDI1019|FUNC_01|VEN_1022&DEV_15E[23]|VEN_1002&DEV_1640|VEN_10EC')
} | Sort-Object Class, FriendlyName

$rows = @(foreach ($d in $devs) {
    $p = Get-DevProps $d.InstanceId
    [pscustomobject]@{
        Class        = $d.Class
        Status       = $d.Status
        FriendlyName = $d.FriendlyName
        InstanceId   = $d.InstanceId
        Inf          = $p['DEVPKEY_Device_DriverInfPath']
        DriverVer    = $p['DEVPKEY_Device_DriverVersion']
        Provider     = $p['DEVPKEY_Device_DriverProvider']
        DriverDesc   = $p['DEVPKEY_Device_DriverDesc']
        Service      = $p['DEVPKEY_Device_Service']
        Parent       = $p['DEVPKEY_Device_Parent']
        HardwareIds  = (@($p['DEVPKEY_Device_HardwareIds']) -join ' | ')
        CompatIds    = (@($p['DEVPKEY_Device_CompatibleIds']) -join ' | ')
    }
})
$rows | Format-List | Out-String -Width 300 | Add-Content $Log
$rows | Export-Csv -NoTypeInformation -Path (Join-Path $Out '01-audio-pnp-devices.csv')
"Found $($rows.Count) audio-related devices." | Add-Content $Log

# ---------------------------------------------------------------------------
# 2. Audio ENDPOINTS (what Sound settings shows) and which device backs them
# ---------------------------------------------------------------------------
Write-Host "[2/7] Audio endpoints..."
Section "2. Audio endpoints (capture = microphones) -> parent device" | Add-Content $Log
$all | Where-Object { $_.Class -eq 'AudioEndpoint' } | Sort-Object FriendlyName | ForEach-Object {
    $p = Get-DevProps $_.InstanceId
    "{0,-8} {1,-55} parent={2}" -f $_.Status, $_.FriendlyName, $p['DEVPKEY_Device_Parent']
} | Add-Content $Log

# MMDevices registry: full property dump for every CAPTURE endpoint
$mm = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
$mmFile = Join-Path $Out '02-capture-endpoints-registry.txt'
if (Test-Path $mm) {
    Get-ChildItem $mm | ForEach-Object {
        "==== endpoint $($_.PSChildName)  DeviceState=$((Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DeviceState)"
        $propKey = Join-Path $_.PSPath 'Properties'
        if (Test-Path $propKey) {
            $props = Get-ItemProperty $propKey -ErrorAction SilentlyContinue
            $name  = $props.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
            "  FriendlyName: $name"
            $props.PSObject.Properties | Where-Object { $_.Name -like '{*' } | ForEach-Object {
                $v = $_.Value
                if ($v -is [byte[]]) { $v = 'BINARY(' + $v.Length + ') ' + (($v | Select-Object -First 32 | ForEach-Object { $_.ToString('x2') }) -join ' ') }
                "  {0} = {1}" -f $_.Name, $v
            }
        }
        ""
    } | Set-Content $mmFile
    "Capture endpoint registry dump: 02-capture-endpoints-registry.txt" | Add-Content $Log
} else { "MMDevices\Audio\Capture key not found" | Add-Content $Log }

# ---------------------------------------------------------------------------
# 3. Signed drivers (INF file names -> which package is Realtek / AMD)
# ---------------------------------------------------------------------------
Write-Host "[3/7] Signed drivers (this step can take ~30 s)..."
Section "3. Signed audio drivers (Win32_PnPSignedDriver)" | Add-Content $Log
$drv = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue | Where-Object {
    ($_.DeviceName -match 'audio|sound|realtek|\bacp\b|coprocessor|\bmic') -or
    ($_.DeviceID   -match 'HDAUDIO|\\ACP|VEN_1022&DEV_15E[23]|VEN_1002&DEV_1640|VEN_10EC') -or
    ($_.InfName    -match 'hdx|rtk|realtek|acp|amdi2s|amdaudio')
})
$drv | Select-Object DeviceName, DeviceID, DeviceClass, DriverProviderName, DriverVersion, DriverDate, InfName, Manufacturer |
    Format-List | Out-String -Width 300 | Add-Content $Log
$drv | Export-Csv -NoTypeInformation -Path (Join-Path $Out '03-signed-audio-drivers.csv')

# ---------------------------------------------------------------------------
# 4. Copy the INF files (they list every device the driver binds, incl. DMIC)
# ---------------------------------------------------------------------------
Write-Host "[4/7] Copying INF files..."
Section "4. INF files copied" | Add-Content $Log
$infDir = Join-Path $Out 'inf'
New-Item -ItemType Directory -Force -Path $infDir | Out-Null
$infNames = @(@($drv | ForEach-Object { $_.InfName }) + @($rows | ForEach-Object { $_.Inf })) |
    Where-Object { $_ } | ForEach-Object { $_.ToString().Trim() } | Sort-Object -Unique
foreach ($inf in $infNames) {
    $src = Join-Path "$env:WINDIR\INF" $inf
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $infDir $inf) -Force
        "copied $inf" | Add-Content $Log
    } else { "missing $inf" | Add-Content $Log }
}
# DriverStore packages for Realtek HDA / AMD ACP (INF + small text files only, no binaries)
$repo = "$env:WINDIR\System32\DriverStore\FileRepository"
Get-ChildItem $repo -Directory -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(hdx|hdaudio|hdaudbus|rtk|realtek|amdacp|amdi2s|amdaudio|amdhda|amd_?acp|nau8|es83|cs42)' -or
    $_.Name -match 'audio|dmic|realtek|acpbus|acpdmic'
} | ForEach-Object {
    $dest = Join-Path $infDir ("driverstore_" + $_.Name)
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Get-ChildItem $_.FullName -Recurse -File -Include *.inf,*.txt,*.ini,*.cfg,*.xml,*.json -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -lt 5MB } |
        ForEach-Object { Copy-Item $_.FullName -Destination (Join-Path $dest $_.Name) -Force }
    "driverstore package: $($_.Name)" | Add-Content $Log
}

# ---------------------------------------------------------------------------
# 5. Registry exports (Realtek driver settings live in the MEDIA class key;
#    they can contain the codec verb/GPIO/pin tables Linux is missing)
# ---------------------------------------------------------------------------
Write-Host "[5/7] Registry exports..."
Section "5. Registry exports" | Add-Content $Log
$regDir = Join-Path $Out 'registry'
New-Item -ItemType Directory -Force -Path $regDir | Out-Null
$keys = [ordered]@{
    'media-class'      = 'HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e96c-e325-11ce-bfc1-08002be10318}'
    'enum-hdaudio'     = 'HKLM\SYSTEM\CurrentControlSet\Enum\HDAUDIO'
    'enum-acp'         = 'HKLM\SYSTEM\CurrentControlSet\Enum\ACP'
    'enum-mmdevapi'    = 'HKLM\SYSTEM\CurrentControlSet\Enum\SWD\MMDEVAPI'
    'mmdevices'        = 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices'
    'software-realtek' = 'HKLM\SOFTWARE\Realtek'
    'software-amd'     = 'HKLM\SOFTWARE\AMD'
}
# plus every service whose name looks audio-related
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Services' -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match 'acp|audio|rtk|realtek|hdaud|intcaud|nau|es8' } |
    ForEach-Object { $keys['service-' + $_.PSChildName] = 'HKLM\SYSTEM\CurrentControlSet\Services\' + $_.PSChildName }

foreach ($k in $keys.GetEnumerator()) {
    $f = Join-Path $regDir ($k.Key + '.reg')
    $null = & reg.exe export "$($k.Value)" "$f" /y 2>&1
    if (Test-Path $f) {
        "exported {0,-40} ({1} KB)" -f $k.Key, [int]((Get-Item $f).Length/1KB) | Add-Content $Log
    } else { "not present: $($k.Value)" | Add-Content $Log }
}

# AMD audio PCI functions and their child devices
Section "5b. AMD audio PCI functions (DEV_15E2 = ACP coprocessor, DEV_15E3 = HDA controller, 1002:1640 = HDMI audio)" | Add-Content $Log
$all | Where-Object { $_.InstanceId -match 'PCI\\VEN_1022&DEV_15E[23]|PCI\\VEN_1002&DEV_1640' } | ForEach-Object {
    "{0,-8} {1,-50} {2}" -f $_.Status, $_.FriendlyName, $_.InstanceId
    $kids = Get-DevProps $_.InstanceId
    if ($kids['DEVPKEY_Device_Children']) { @($kids['DEVPKEY_Device_Children']) | ForEach-Object { "            child: $_" } }
    if ($kids['DEVPKEY_Device_DriverInfPath']) { "            inf:   $($kids['DEVPKEY_Device_DriverInfPath'])  ($($kids['DEVPKEY_Device_DriverProvider']) $($kids['DEVPKEY_Device_DriverVersion']))" }
} | Add-Content $Log

# ---------------------------------------------------------------------------
# 6. Full driver list + hardware summary
# ---------------------------------------------------------------------------
Write-Host "[6/7] driverquery / system info..."
$null = & driverquery.exe /v /fo csv 2>&1 | Set-Content (Join-Path $Out '06-driverquery.csv')
Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue | Format-List * | Out-String -Width 300 | Set-Content (Join-Path $Out '06-Win32_SoundDevice.txt')
Get-CimInstance Win32_ComputerSystemProduct -ErrorAction SilentlyContinue | Format-List * | Out-String | Set-Content (Join-Path $Out '06-system.txt')
Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue | Format-List * | Out-String | Add-Content (Join-Path $Out '06-system.txt')
Get-CimInstance Win32_BaseBoard -ErrorAction SilentlyContinue | Format-List * | Out-String | Add-Content (Join-Path $Out '06-system.txt')

# ---------------------------------------------------------------------------
# 7. Done
# ---------------------------------------------------------------------------
Write-Host "[7/7] Finishing..."
"" | Add-Content $Log
"DONE. Files are in: $Out" | Add-Content $Log
Stop-Transcript | Out-Null

Write-Host ""
Write-Host "==== DONE ====" -ForegroundColor Green
Write-Host "Report folder: $Out"
Write-Host "Open 00-summary.txt and check that section 2 lists your microphone with a parent= value."
Write-Host ""
Get-Content $Log | Select-String -Pattern 'parent=' | ForEach-Object { Write-Host $_.Line -ForegroundColor Cyan }
