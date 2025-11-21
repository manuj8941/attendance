# Test sequence for attendance app endpoints
# 1) Login as owner_admin (smita)
# 2) GET /admin/users
# 3) POST /admin/users/add (testuser)
# 4) POST /admin/users/reset-password (bulk employees -> 222)
# 5) POST /admin/users/reset-password (per-user testuser -> 333)
# 6) Login as testuser with password 333
# 7) POST /user/change-password (testuser changes 333 -> newpass)

Write-Host "Starting test sequence..."

# For local HTTPS testing with self-signed/mkcert certs, trust the cert validation for this session
[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }

# Wait a short time to ensure server is up
Start-Sleep -Seconds 1

$sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
    $login = Invoke-WebRequest -Uri 'https://192.168.1.9:3000/login' -Method POST -Body @{name='smita'; password='111'} -WebSession $sess -UseBasicParsing -TimeoutSec 10
    Write-Host "Login (smita) status: $($login.StatusCode)"
} catch {
    Write-Host "Login request failed: $($_.Exception.Message)"
}

try {
    $users = Invoke-WebRequest -Uri 'https://192.168.1.9:3000/admin/users' -WebSession $sess -UseBasicParsing -TimeoutSec 10
    Write-Host "GET /admin/users response:`n$($users.Content)"
} catch {
    Write-Host "Failed to get users: $($_.Exception.Message)"
}

try {
    $addBody = @{name='testuser'; password='111'; role='employee'} | ConvertTo-Json
    $add = Invoke-WebRequest -Uri 'https://192.168.1.9:3000/admin/users/add' -Method POST -Body $addBody -ContentType 'application/json' -WebSession $sess -UseBasicParsing -TimeoutSec 10
    Write-Host "/admin/users/add response:`n$($add.Content)"
} catch {
    Write-Host "Failed to add user: $($_.Exception.Message)"
}

try {
    $bulkBody = @{scope='employees'; password='222'} | ConvertTo-Json
    $bulk = Invoke-WebRequest -Uri 'https://192.168.1.9:3000/admin/users/reset-password' -Method POST -Body $bulkBody -ContentType 'application/json' -WebSession $sess -UseBasicParsing -TimeoutSec 10
    Write-Host "/admin/users/reset-password (bulk) response:`n$($bulk.Content)"
} catch {
    Write-Host "Failed bulk reset: $($_.Exception.Message)"
}

try {
    $perBody = @{username='testuser'; password='333'} | ConvertTo-Json
    $per = Invoke-WebRequest -Uri 'https://192.168.1.9:3000/admin/users/reset-password' -Method POST -Body $perBody -ContentType 'application/json' -WebSession $sess -UseBasicParsing -TimeoutSec 10
    Write-Host "/admin/users/reset-password (per-user) response:`n$($per.Content)"
} catch {
    Write-Host "Failed per-user reset: $($_.Exception.Message)"
}

# Login as testuser with updated password
$sess2 = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
    $login2 = Invoke-WebRequest -Uri 'https://192.168.1.9:3000/login' -Method POST -Body @{name='testuser'; password='333'} -WebSession $sess2 -UseBasicParsing -TimeoutSec 10
    Write-Host "Login (testuser) status: $($login2.StatusCode)"
} catch {
    Write-Host "Login (testuser) failed: $($_.Exception.Message)"
}

try {
    $chgBody = @{old_password='333'; new_password='newpass'} | ConvertTo-Json
    $chg = Invoke-WebRequest -Uri 'https://192.168.1.9:3000/user/change-password' -Method POST -Body $chgBody -ContentType 'application/json' -WebSession $sess2 -UseBasicParsing -TimeoutSec 10
    Write-Host "/user/change-password response:`n$($chg.Content)"
} catch {
    Write-Host "Failed change-password: $($_.Exception.Message)"
}

Write-Host "Test sequence finished." 
