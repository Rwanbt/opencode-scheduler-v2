param(
  [switch]$ConfirmEphemeralRunner,
  [switch]$ConfirmDisposableManualHost
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# NEVER provision a local account or a Task Scheduler folder by default.
if (-not (($ConfirmEphemeralRunner -and $env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted') -or
          ($ConfirmDisposableManualHost -and $env:SCHEDULER_ACL_MANUAL_CONSENT -eq 'disposable-vm-only'))) {
  throw 'This harness runs only on an approved GitHub-hosted Windows runner or explicitly acknowledged disposable VM'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows only' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'CROSS_USER_ACL_NOT_QUALIFIED: runner cannot create a disposable local user (not elevated)'
}
$id = [Guid]::NewGuid().ToString('N')
$account = 'OCACL' + $id.Substring(0, 9) # Windows local users: <= 20 chars
$taskName = '\OpenCode\opencode-job-acl-' + $id.Substring(0, 12)
$leaf = $taskName.Substring(10)
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$temp = Join-Path $temporaryRoot ('scheduler-crossuser-' + $id)
New-Item -ItemType Directory -Path $temp -ErrorAction Stop | Out-Null
$childProof = Join-Path $temp 'child.json'
$pluginProof = Join-Path $temp 'plugin.json'
$userCreated = $false
$folderCreated = $false
$foreignVerified = $false
$svc = $null
$folder = $null
$teardownFailed = $false
try {
  $svc = New-Object -ComObject 'Schedule.Service'
  $svc.Connect()
  $root = $svc.GetFolder('\')
  try { $null = $svc.GetFolder('\OpenCode'); throw 'Existing \OpenCode Task Scheduler folder: refusing modification' }
  catch {
    $hresult = '{0:X8}' -f ($_.Exception.HResult -band 0xFFFFFFFF)
    if ($hresult -notin @('80070002', '80070003')) { throw }
  }
  $password = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N'))
  $securePassword = ConvertTo-SecureString $password -AsPlainText -Force
  $null = New-LocalUser -Name $account -Password $securePassword -PasswordNeverExpires -UserMayNotChangePassword -Description 'Ephemeral OpenCode ACL test only'
  $userCreated = $true
  $sid = (Get-LocalUser -Name $account).SID.Value
  # The impersonated child must be able to place its attestation in a private
  # ephemeral fixture folder; GitHub runner TEMP is not generally writable by
  # an unrelated standard account.
  & icacls.exe $temp /grant ('*' + $sid + ':(OI)(CI)M') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to authorize isolated child evidence directory' }
  $folder = $root.CreateFolder('OpenCode', $null)
  $folderCreated = $true
  # A specifically NEW folder on a disposable runner; give only the temporary
  # standard account sufficient rights to register *its own* test task.
  $dacl = $folder.GetSecurityDescriptor(4)
  if (-not $dacl.StartsWith('D:')) { throw 'Cannot inspect disposable folder DACL' }
  $folder.SetSecurityDescriptor(($dacl + '(A;;GA;;;' + $sid + ')'), 4)
  $credential = New-Object Security.Management.Automation.PSCredential("$env:COMPUTERNAME\$account", $securePassword)
  $child = Join-Path $PSScriptRoot 'windows-crossuser-child.ps1'
  $argsLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $child + '" -TaskName "' + $taskName + '" -ReportPath "' + $childProof + '"'
  $process = Start-Process -FilePath "$PSHOME\powershell.exe" -Credential $credential -ArgumentList $argsLine -LoadUserProfile -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $childProof)) {
    throw "CROSS_USER_ACL_NOT_QUALIFIED: impersonated standard account could not create disabled Task Scheduler fixture (exit $($process.ExitCode))"
  }
  $childResult = Get-Content -LiteralPath $childProof -Raw | ConvertFrom-Json
  if ($childResult.sid -ne $sid -or $sid -eq $identity.User.Value -or $childResult.task -ne $taskName) {
    throw 'CROSS_USER_ACL_NOT_QUALIFIED: impersonated token did not attest a separate local user SID'
  }
  $task = $folder.GetTask($leaf)
  $principalName = $task.Definition.Principal.UserId
  if ($principalName -match '^S-1-5-') { $taskSid = $principalName }
  else { $taskSid = (New-Object Security.Principal.NTAccount($principalName)).Translate([Security.Principal.SecurityIdentifier]).Value }
  if ($taskSid -ne $sid -or $task.Enabled) { throw 'CROSS_USER_ACL_NOT_QUALIFIED: disabled foreign principal is not independently attested' }
  $foreignVerified = $true

  $env:SCHEDULER_ACL_EPHEMERAL_APPROVAL = 'fixture-only'
  $env:SCHEDULER_ACL_FOREIGN_TASK = $taskName
  $env:SCHEDULER_ACL_OUTPUT = $pluginProof
  & node (Join-Path $PSScriptRoot 'windows-crossuser-plugin.mjs')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pluginProof)) { throw 'Native plugin scoped nondeletion failed' }
  $result = Get-Content -LiteralPath $pluginProof -Raw | ConvertFrom-Json
  $surviving = $folder.GetTask($leaf)
  if ($null -eq $surviving -or $surviving.Definition.Principal.UserId -ne $principalName) {
    throw 'Foreign principal task not preserved after native scoped deletion'
  }
  $report = [ordered]@{
    runnerSid = $identity.User.Value; childSid = $sid; createdTaskPrincipalSid = $taskSid
    expectedForeignTask = $taskName
    foreignTaskBefore = @($result.foreignTaskBefore); foreignTaskAfter = @($result.foreignTaskAfter)
    ownedTaskNames = @($result.ownedTaskNames); deletedOwnedTasks = @($result.deletedOwnedTasks)
    backendMutationSucceeded = $result.backendMutationSucceeded
  }
  $reportPath = Join-Path $temp 'evidence.json'
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  # The JS test requires all SID, task-name and before/after invariants.
  $env:SCHEDULER_ACL_EVIDENCE = $reportPath
  & bun scripts/windows-acl-verify.ts
  if ($LASTEXITCODE -ne 0) { throw 'Adversarial evidence verifier rejected cross-user qualification' }
  Write-Host 'CROSS_USER_NATIVE_DIFFERENT_PRINCIPAL_NONDELETION_PASS'
  Write-Host 'CROSS_USER_ACL_DELETE_DENIAL_NOT_TESTED: distinct identity/nondeletion only, not a non-admin ACL-denied delete proof'
} finally {
  if ($foreignVerified) {
    try {
      $current = $folder.GetTask($leaf)
      if ($current.Definition.Principal.UserId -ne $principalName) { throw 'Foreign task principal changed' }
      $folder.DeleteTask($leaf, 0)
      try { $null = $folder.GetTask($leaf); throw 'Task survived cleanup' }
      catch {
        $hresult = '{0:X8}' -f ($_.Exception.HResult -band 0xFFFFFFFF)
        if ($hresult -notin @('80070002', '80070003')) { throw }
      }
    } catch { $teardownFailed = $true; Write-Error "Exact foreign task cleanup failed: $_" -ErrorAction Continue }
  }
  if ($folderCreated -and -not $teardownFailed) {
    try {
      if ($folder.GetTasks(1).Count -ne 0 -or $folder.GetFolders(0).Count -ne 0) { throw 'Folder contains unexpected tasks: refusing cleanup' }
      $root.DeleteFolder('OpenCode', 0)
    } catch { $teardownFailed = $true; Write-Error "Disposable folder cleanup failed: $_" -ErrorAction Continue }
  }
  if ($userCreated -and -not $teardownFailed) {
    try { Remove-LocalUser -Name $account -ErrorAction Stop }
    catch { $teardownFailed = $true; Write-Error "Disposable user cleanup failed: $_" -ErrorAction Continue }
  }
  if (-not $teardownFailed) { Remove-Item -LiteralPath $temp -Recurse -Force }
  else { Write-Error "CROSS_USER_ACL_CLEANUP_NOT_QUALIFIED: retain $temp on disposable runner for diagnosis" -ErrorAction Continue }
}
if ($teardownFailed) { throw 'CROSS_USER_ACL_CLEANUP_NOT_QUALIFIED' }
