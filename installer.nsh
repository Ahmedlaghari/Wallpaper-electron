!macro customInstall
ExecWait 'powershell -ExecutionPolicy Bypass -File "$INSTDIR\resources\fonts\install-font.ps1"'
WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Live Wallpaper" "$INSTDIR\Live Wallpaper.exe"
!macroend
