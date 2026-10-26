; 标记 NSIS 安装版，win-unpacked / 开发环境不提供自动安装能力。
!macro customInstall
  Push $0
  FileOpen $0 "$INSTDIR\resources\libretv-installed" w
  FileWrite $0 "nsis"
  FileClose $0
  Pop $0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\resources\libretv-installed"
!macroend
