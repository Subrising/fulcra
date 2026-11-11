# FU-780: adds a trigger that repeats every 5 minutes to an exported "Fulcra Daemon At Boot" task XML.
# The principal (S4U, no stored password), the boot trigger and the action stay as they are.
# Use: schtasks /query /tn "Fulcra Daemon At Boot" /xml > in.xml, run this, then schtasks /create /xml out.xml /f.
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = "Stop"
[xml]$task = Get-Content -LiteralPath $In -Raw
$ns = New-Object System.Xml.XmlNamespaceManager($task.NameTable)
$uri = "http://schemas.microsoft.com/windows/2004/02/mit/task"
$ns.AddNamespace("t", $uri)
$triggers = $task.SelectSingleNode("/t:Task/t:Triggers", $ns)
if ($null -eq $triggers) { throw "The task XML has no Triggers element." }
if ($null -eq $task.SelectSingleNode("/t:Task/t:Principals/t:Principal[t:LogonType='S4U']", $ns)) {
  throw "The task principal is not S4U. Stop and check the task."
}
if ($null -ne $task.SelectSingleNode("/t:Task/t:Triggers/t:TimeTrigger[t:Repetition/t:Interval='PT5M']", $ns)) {
  Write-Output "The 5-minute trigger is already present. No change."
} else {
  $time = $task.CreateElement("TimeTrigger", $uri)
  $repetition = $task.CreateElement("Repetition", $uri)
  $interval = $task.CreateElement("Interval", $uri); $interval.InnerText = "PT5M"
  $stop = $task.CreateElement("StopAtDurationEnd", $uri); $stop.InnerText = "false"
  [void]$repetition.AppendChild($interval); [void]$repetition.AppendChild($stop)
  $start = $task.CreateElement("StartBoundary", $uri)
  $start.InnerText = (Get-Date).Date.ToString("yyyy-MM-ddTHH:mm:ss")
  $enabled = $task.CreateElement("Enabled", $uri); $enabled.InnerText = "true"
  [void]$time.AppendChild($repetition); [void]$time.AppendChild($start); [void]$time.AppendChild($enabled)
  [void]$triggers.AppendChild($time)
  Write-Output "Added a trigger that repeats every 5 minutes with no end."
}
$settings = New-Object System.Xml.XmlWriterSettings
$settings.Encoding = [System.Text.Encoding]::Unicode
$settings.Indent = $true
$writer = [System.Xml.XmlWriter]::Create($Out, $settings)
$task.Save($writer); $writer.Close()
