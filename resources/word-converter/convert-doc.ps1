param(
  [Parameter(Mandatory=$true)][string]$SessionRoot,
  [Parameter(Mandatory=$true)][ValidateSet('Convert','Cleanup')][string]$Operation
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $SessionRoot).Path
$ownerPath=Join-Path $root 'owner.json'
$activationPending=Join-Path $root 'activation.pending'
$resultPath=Join-Path $root 'result.json'
$source=Join-Path $root 'source.doc'
$output=Join-Path $root 'converted.docx'

# Cleanup may run after the COM call has timed out and its PowerShell host exited.
# Never enumerate/terminate Word by name: ownership requires PID, creation time and executable.
if($Operation -eq 'Cleanup') {
  try {
    if(-not (Test-Path -LiteralPath $ownerPath)){
      if(Test-Path -LiteralPath $activationPending){exit 1}
      exit 0
    }
    $owner=Get-Content -LiteralPath $ownerPath -Raw | ConvertFrom-Json
    if($owner.pid -isnot [int] -or $owner.pid -le 0 -or -not $owner.startTimeTicks -or -not $owner.executablePath){exit 1}
    $ownedProcess=Get-Process -Id $owner.pid -ErrorAction SilentlyContinue
    if($null -eq $ownedProcess){exit 0}
    if($ownedProcess.ProcessName -ne 'WINWORD' -or
       [string]$ownedProcess.StartTime.ToUniversalTime().Ticks -cne [string]$owner.startTimeTicks -or
       $ownedProcess.Path -ine $owner.executablePath){exit 1}
    $ownedProcess.Kill()
    if(-not $ownedProcess.WaitForExit(5000)){exit 1}
    exit 0
  } catch {exit 1}
}

$word=$null;$document=$null;$probe=$null;$owned=$false;$failure='WORD_UNAVAILABLE'
try {
  if(-not (Test-Path -LiteralPath $source) -or (Test-Path -LiteralPath $output)){throw 'INVALID_PRIVATE_FILES'}
  $previousPids=@(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object Id)
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XiaoguiWordProcess {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  // Invoke with CLR values: Windows PowerShell may otherwise pass a PSObject-wrapped path to COM.
  public static void SaveDocx(object document, string path) {
    document.GetType().InvokeMember("SaveAs2", System.Reflection.BindingFlags.InvokeMethod, null,
      document, new object[] { path, 16, false, "", false });
  }
}
'@
  [IO.File]::WriteAllText($activationPending,'pending')
  $word=New-Object -ComObject Word.Application
  $word.Visible=$false
  $word.AutomationSecurity=3
  $word.DisplayAlerts=0
  if($word.Documents.Count -ne 0){throw 'WORD_INSTANCE_NOT_EMPTY'}
  $probe=$word.Documents.Add()
  [uint32]$wordPid=0
  [void][XiaoguiWordProcess]::GetWindowThreadProcessId([IntPtr]$probe.Windows.Item(1).Hwnd,[ref]$wordPid)
  if($wordPid -eq 0 -or $previousPids -contains $wordPid){throw 'WORD_INSTANCE_NOT_OWNED'}
  $process=Get-Process -Id $wordPid
  if($process.ProcessName -ne 'WINWORD'){throw 'UNEXPECTED_WORD_PROCESS'}
  $owned=$true
  $owner=@{pid=[int]$wordPid;startTimeTicks=[string]$process.StartTime.ToUniversalTime().Ticks;executablePath=$process.Path}
  [IO.File]::WriteAllText($ownerPath,($owner | ConvertTo-Json -Compress))
  [IO.File]::Delete($activationPending)
  $probe.Close(0);$probe=$null
  $failure='WORD_FAILED'
  $document=$word.Documents.Open($source,$false,$true,$false)
  if(-not $document.ReadOnly -or $word.AutomationSecurity -ne 3){throw 'WORD_READONLY_REQUIRED'}
  # wdFormatDocumentDefault=16; source is a private copy, output cannot overwrite an existing file.
  [XiaoguiWordProcess]::SaveDocx($document,[string]$output)
  $document.Close(0);$document=$null
  if(-not (Test-Path -LiteralPath $output)){$failure='WORD_OUTPUT_MISSING';throw 'WORD_OUTPUT_MISSING'}
  [IO.File]::WriteAllText($resultPath,'{"code":"OK"}')
} catch {
  if($null -eq $word){[IO.File]::Delete($activationPending)}
  [IO.File]::WriteAllText($resultPath,(@{code=$failure} | ConvertTo-Json -Compress))
  exit 1
} finally {
  # Close only document objects created above. Never attach to or close user documents.
  if($null -ne $probe){try{$probe.Close(0)}catch{}}
  if($owned){
    if($null -ne $document){try{$document.Close(0)}catch{}}
    try{$word.Quit(0)}catch{}
  }
}
