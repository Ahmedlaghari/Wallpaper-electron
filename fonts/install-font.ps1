$font = "$PSScriptRoot\anurati.ttf"
$fonts = (New-Object -ComObject Shell.Application).Namespace(0x14)

$fonts.CopyHere($font)