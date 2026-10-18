param(
  [Parameter(Mandatory = $true)][string]$TaskName,
  [Parameter(Mandatory = $true)][string]$ReportPath
)
$ErrorActionPreference = 'Stop'
if ($TaskName -notmatch '^\\OpenCode\\opencode-job-acl-[a-f0-9]{12}$') { throw 'Invalid isolated foreign task name' }
if (Test-Path -LiteralPath $ReportPath) { throw 'Refusing to replace prior child report' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\OpenCode')
$leaf = $TaskName.Substring(10)
try { $null = $folder.GetTask($leaf); throw 'Foreign fixture task already exists' }
catch [System.Runtime.InteropServices.COMException] {
  $hresult = '{0:X8}' -f ($_.Exception.HResult -band 0xFFFFFFFF)
  if ($hresult -notin @('80070002', '80070003')) { throw }
}
# Register a disabled, never-executed, inert task as the actual impersonated
# standard Windows user. No password/logon secrets or OpenCode command is saved.
$task = $service.NewTask(0)
$task.RegistrationInfo.Description = 'Disposable OpenCode Scheduler cross-user ACL test fixture'
$task.Principal.UserId = $identity.Name
$task.Principal.LogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
$task.Settings.Enabled = $false
$task.Settings.AllowDemandStart = $false
$action = $task.Actions.Create(0)
$action.Path = "$env:SystemRoot\System32\cmd.exe"
$action.Arguments = '/c exit 0'
$trigger = $task.Triggers.Create(1)
$trigger.StartBoundary = (Get-Date).AddYears(5).ToString('s')
$null = $folder.RegisterTaskDefinition($leaf, $task, 2, $null, $null, 3, $null)
$evidence = @{ sid = $identity.User.Value; account = $identity.Name; task = $TaskName; state = 'registered-disabled' }
$evidence | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReportPath -Encoding UTF8 -NoNewline
