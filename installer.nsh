!macro customInstall
ExecWait 'powershell -ExecutionPolicy Bypass -File "$INSTDIR\resources\fonts\install-font.ps1"'
!macroend
