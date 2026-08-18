; 更新旧版本时自动搬迁用户数据(customInit 在 .onInit 中执行,
; 早于安装流程里"静默卸载旧版、清空安装目录"的步骤,此时 $INSTDIR 已指向旧安装目录)
;
; 旧版布局:data/ 与 context-data/ 都在安装目录内,更新清空安装目录时会被一并删掉
; 新版布局:%APPDATA%\UmiClaw\data(业务数据)与 %APPDATA%\UmiClaw(Electron userData)
;
; 局限:per-machine(所有用户)安装时安装器以管理员身份运行,$APPDATA 指向的是
; 管理员账户而非实际使用者,此搬迁不生效(本应用默认 per-user 安装,不受影响)。
!include "LogicLib.nsh"

!macro customInit
  ; 旧安装目录以注册表 InstallLocation 为准($INSTDIR 在用户更换安装目录时
  ; 指向新目录,而旧版卸载器清除的是注册表记录的旧目录,数据搬迁必须对齐后者)
  ReadRegStr $R9 SHCTX "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R9 == ""
  ${OrIfNot} ${FileExists} "$R9"
    StrCpy $R9 "$INSTDIR"
  ${EndIf}

  ; 1) context-data(旧版 Electron userData)整体就位,仅当目标尚未初始化
  ${If} ${FileExists} "$R9\context-data\*.*"
  ${AndIfNot} ${FileExists} "$APPDATA\UmiClaw\*.*"
    ClearErrors
    Rename "$R9\context-data" "$APPDATA\UmiClaw"
    ${If} ${Errors}
      DetailPrint "context-data 搬迁失败(可能被占用),跳过"
    ${Else}
      DetailPrint "已将旧版用户数据(context-data)迁移到 $APPDATA\UmiClaw"
    ${EndIf}
  ${EndIf}
  CreateDirectory "$APPDATA\UmiClaw"

  ; 2) data(工作区/凭据/技能/配置)搬到 %APPDATA%\UmiClaw\data
  ${If} ${FileExists} "$R9\data\config\.openclaw"
  ${AndIfNot} ${FileExists} "$APPDATA\UmiClaw\data\config\.openclaw"
    ClearErrors
    Rename "$R9\data" "$APPDATA\UmiClaw\data"
    ${If} ${Errors}
      MessageBox MB_ICONEXCLAMATION|MB_OK "无法自动迁移用户数据(文件可能正被 Excel、WPS 等程序占用)。$\r$\n$\r$\n请关闭相关程序后重新运行安装程序;强行继续将导致旧数据丢失。"
    ${Else}
      DetailPrint "已将旧版用户数据(data)迁移到 $APPDATA\UmiClaw\data"
    ${EndIf}
  ${EndIf}
!macroend
