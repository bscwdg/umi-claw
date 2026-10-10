# list-node-starts.ps1
# 输出全部 node 进程：每行 "<pid>|<ISO启动时间(UTC)>"，供 _cleanStaleAgentLeases 解析。
# 独立脚本避免「node -e 内联 -> cmd -> powershell」多层引号转义。
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    "$($_.ProcessId)|$($_.CreationDate.ToString('o'))"
}
