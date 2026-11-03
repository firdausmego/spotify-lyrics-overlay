' Double-click to start the lyrics overlay without a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  MsgBox "Electron is not installed yet. Run 'npm install' in this folder first.", 48, "Lyrics Overlay"
  WScript.Quit 1
End If
CreateObject("WScript.Shell").Run """" & exe & """ """ & dir & """", 0, False
