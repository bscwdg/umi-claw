# 生成一张带文字的测试图，用于 SPIKE S7（多模态 image_url）验证。
# 输出：同目录下 s7-test.png（含易识别的大写英文暗号，便于判断模型是真的"读到"了文字）
Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $dir 's7-test.png'

$w = 720; $h = 220
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::White)

$font = New-Object System.Drawing.Font('Consolas', 44, [System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
$g.DrawString('UMI-CLAW-00', $font, $brush, 30, 30)
$g.DrawString('GATEWAY OK', $font, $brush, 30, 110)

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$len = (Get-Item $out).Length
Write-Output "written: $out ($len bytes)"
