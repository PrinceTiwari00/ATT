; ─────────────────────────────────────────────────────────────────────────────
;  ATT for Windows — custom NSIS hooks (electron-builder `nsis.include`)
; ─────────────────────────────────────────────────────────────────────────────
;  electron-builder includes this file at the very TOP of the generated script,
;  so everything here is defined before the assisted-installer template inserts
;  its hooks. Page functions are defined inside the macro (after `Page custom`),
;  exactly like the template expects.
;
;  What the stock installer does not do, and a school deployment needs:
;
;   1. an options page: "run ATT as a background Windows service" so punches
;      keep being pulled at boot, while the PC is locked and when nobody is
;      signed in — plus an optional LAN firewall rule for the dashboard
;   2. create the machine-wide data home C:\ProgramData\ATT and grant standard
;      users Modify; otherwise the database created by the service
;      (LocalSystem) would be read-only for the signed-in user's desktop app
;   3. stop a running service before an upgrade (node.exe would lock the payload)
;   4. on uninstall: remove the service + firewall rule and ASK before deleting
;      attendance history
;
;  Hooks used: customInit · customPageAfterChangeDir · customInstall ·
;              customUnInstall
; ─────────────────────────────────────────────────────────────────────────────

!include MUI2.nsh
!include nsDialogs.nsh
!include LogicLib.nsh

; Must match <id> in desktop/service/att-service.xml and SERVICE_NAME in the app.
!define ATT_SERVICE_ID "ATTAttendance"
!define ATT_DATA_DIR "$PROGRAMDATA\ATT"
!define ATT_FIREWALL_RULE "ATT Attendance"
!define ATT_SERVICE_EXE "$INSTDIR\resources\service\att-service.exe"

!ifndef BUILD_UNINSTALLER

Var AttDialog
Var AttSvcCheckbox
Var AttSvcState
Var AttFwCheckbox
Var AttFwState
Var AttTmp

!macro customInit
  ; Stop a running service BEFORE files are replaced, otherwise node.exe keeps
  ; resources\payload\server.cjs locked and the upgrade fails half-way.
  nsExec::ExecToLog 'sc query ${ATT_SERVICE_ID}'
  Pop $AttTmp
  ${If} $AttTmp == "0"
    DetailPrint "ATT: stopping the background service for this upgrade"
    nsExec::ExecToLog 'sc stop ${ATT_SERVICE_ID}'
    Pop $AttTmp
    Sleep 1500
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom AttOptionsPage AttOptionsPageLeave

  Function AttOptionsPage
    ; On an upgrade keep the page short: the choices are already made.
    !insertmacro MUI_HEADER_TEXT "Background sync and network" "Choose how ATT keeps collecting attendance on this computer."

    nsDialogs::Create 1018
    Pop $AttDialog
    ${If} $AttDialog == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0u 100% 18u "ATT reads punches from your ZKTeco terminal and stores them on this computer."
    Pop $AttTmp

    ${NSD_CreateCheckbox} 0 24u 100% 12u "Run ATT in the background as a Windows service (recommended)"
    Pop $AttSvcCheckbox
    ${If} $AttSvcState == ""
      StrCpy $AttSvcState ${BST_CHECKED}
    ${EndIf}
    ${NSD_SetState} $AttSvcCheckbox $AttSvcState

    ${NSD_CreateLabel} 10u 38u 100% 24u "Starts at boot, keeps syncing while the PC is locked or nobody is signed in, and restarts itself after a crash. You can change this later in ATT → Settings."
    Pop $AttTmp

    ${NSD_CreateCheckbox} 0 68u 100% 12u "Let other computers on the school network open this dashboard"
    Pop $AttFwCheckbox
    ${If} $AttFwState == ""
      StrCpy $AttFwState ${BST_CHECKED}
    ${EndIf}
    ${NSD_SetState} $AttFwCheckbox $AttFwState

    ${NSD_CreateLabel} 10u 82u 100% 24u "Adds a Windows Firewall rule for ATT Attendance (private and domain networks only). Leave unchecked if only this PC is used."
    Pop $AttTmp

    ${NSD_CreateLabel} 0 112u 100% 18u "Attendance data lives in C:\ProgramData\ATT and is never uploaded anywhere."
    Pop $AttTmp

    nsDialogs::Show
  FunctionEnd

  Function AttOptionsPageLeave
    ${NSD_GetState} $AttSvcCheckbox $AttSvcState
    ${NSD_GetState} $AttFwCheckbox $AttFwState
  FunctionEnd
!macroend

!macro customInstall
  ; Silent installs (/S) never show the page — apply the recommended defaults.
  ${If} $AttSvcState == ""
    StrCpy $AttSvcState ${BST_CHECKED}
  ${EndIf}
  ${If} $AttFwState == ""
    StrCpy $AttFwState ${BST_CHECKED}
  ${EndIf}

  ; ── machine-wide data home ────────────────────────────────────────────────
  CreateDirectory "${ATT_DATA_DIR}"
  CreateDirectory "${ATT_DATA_DIR}\logs"
  CreateDirectory "${ATT_DATA_DIR}\backups"

  ; BUILTIN\Users (S-1-5-32-545) needs Modify: the service runs as LocalSystem
  ; and creates attendance.db, which the signed-in user's desktop app must also
  ; be able to write.
  nsExec::ExecToLog 'icacls "${ATT_DATA_DIR}" /grant *S-1-5-32-545:(OI)(CI)M /T'
  Pop $AttTmp
  DetailPrint "ATT: data folder permissions set (icacls exit $AttTmp)"

  ; ── optional firewall rule (dashboard for other staff PCs) ────────────────
  ${If} $AttFwState == ${BST_CHECKED}
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${ATT_FIREWALL_RULE}"'
    Pop $AttTmp
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${ATT_FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=4000 program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" profile=private,domain enable=yes description="ATT attendance dashboard for staff on the school network"'
    Pop $AttTmp
    DetailPrint "ATT: firewall rule added (netsh exit $AttTmp)"
  ${EndIf}

  ; ── optional background service ───────────────────────────────────────────
  ${If} $AttSvcState == ${BST_CHECKED}
    nsExec::ExecToLog 'sc query ${ATT_SERVICE_ID}'
    Pop $AttTmp
    ${If} $AttTmp == "0"
      DetailPrint "ATT: service already installed — restarting it on the new version"
      nsExec::ExecToLog '"${ATT_SERVICE_EXE}" restart'
      Pop $AttTmp
    ${Else}
      nsExec::ExecToLog '"${ATT_SERVICE_EXE}" install'
      Pop $AttTmp
      DetailPrint "ATT: service install exit code $AttTmp"
      nsExec::ExecToLog '"${ATT_SERVICE_EXE}" start'
      Pop $AttTmp
      DetailPrint "ATT: service start exit code $AttTmp"
    ${EndIf}
  ${Else}
    ; A service left over from a previous install must not keep running removed code.
    nsExec::ExecToLog 'sc query ${ATT_SERVICE_ID}'
    Pop $AttTmp
    ${If} $AttTmp == "0"
      nsExec::ExecToLog '"${ATT_SERVICE_EXE}" uninstall'
      Pop $AttTmp
      DetailPrint "ATT: background service removed (not selected this time)"
    ${EndIf}
  ${EndIf}
!macroend

!endif ; BUILD_UNINSTALLER

!macro customUnInstall
  ; Stop and remove the service first so its files are not locked.
  nsExec::ExecToLog 'sc query ${ATT_SERVICE_ID}'
  Pop $0
  ${If} $0 == "0"
    nsExec::ExecToLog '"${ATT_SERVICE_EXE}" stop'
    Pop $0
    Sleep 1200
    nsExec::ExecToLog '"${ATT_SERVICE_EXE}" uninstall'
    Pop $0
    DetailPrint "ATT: background service removed (exit $0)"
  ${EndIf}

  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${ATT_FIREWALL_RULE}"'
  Pop $0

  ; Attendance history is precious — deleting it is always an explicit choice.
  MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION "Delete ATT's attendance data too?$\r$\n$\r$\nThis removes C:\ProgramData\ATT: the database, settings, logs and backups.$\r$\n$\r$\nChoose No to keep it — reinstalling ATT picks the data up again." IDYES attUninstallDeleteData
  Goto attUninstallKeepData

  attUninstallDeleteData:
    RMDir /r "${ATT_DATA_DIR}"
    DetailPrint "ATT: data folder deleted"
    Goto attUninstallDone

  attUninstallKeepData:
    DetailPrint "ATT: data folder kept at ${ATT_DATA_DIR}"

  attUninstallDone:
!macroend
