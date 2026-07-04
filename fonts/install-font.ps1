$fontsFolder = (New-Object -ComObject Shell.Application).Namespace(0x14)

Get-ChildItem -Path "$PSScriptRoot\*.ttf" | ForEach-Object {
    $installed = Join-Path "$env:windir\Fonts" $_.Name
    if (-not (Test-Path $installed)) {
        # 0x14 = silent + yes-to-all
        $fontsFolder.CopyHere($_.FullName, 0x14)
    }
}
