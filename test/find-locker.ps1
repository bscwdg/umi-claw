# Use Windows Restart Manager to find which processes lock a file
param([Parameter(Mandatory=$true)][string]$Path)

$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class Rm {
    [StructLayout(LayoutKind.Sequential)]
    struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }

    const int RmRebootReasonNone = 0;
    const int CCH_RM_MAX_APP_NAME = 255;
    const int CCH_RM_MAX_SVC_NAME = 63;

    enum RM_APP_TYPE { RmUnknownApp=0, RmMainWindow=1, RmOtherWindow=2, RmService=3, RmExplorer=4, RmConsole=5, RmCritical=1000 }

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct RM_PROCESS_INFO {
        public RM_UNIQUE_PROCESS Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_APP_NAME+1)] public string strAppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=CCH_RM_MAX_SVC_NAME+1)] public string strServiceShortName;
        public RM_APP_TYPE ApplicationType;
        public uint AppStatus;
        public uint TSSessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
    }

    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmStartSession(out uint pSessionHandle, int dwSessionFlags, string strSessionKey);

    [DllImport("rstrtmgr.dll")]
    static extern int RmEndSession(uint pSessionHandle);

    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmRegisterResources(uint pSessionHandle, uint nFiles, string[] rgsFilenames,
        uint nApplications, RM_UNIQUE_PROCESS[] rgApplications, uint nServices, string[] rgsServiceNames);

    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint dwSessionHandle, out uint pnProcInfoNeeded, ref uint pnProcInfo,
        [In, Out] RM_PROCESS_INFO[] rgAffectedApps, ref uint lpdwRebootReasons);

    public static List<string> WhoLocks(string path) {
        var result = new List<string>();
        uint handle;
        string key = Guid.NewGuid().ToString();
        int rc = RmStartSession(out handle, 0, key);
        if (rc != 0) throw new Exception("RmStartSession failed: " + rc);
        try {
            string[] resources = new string[] { path };
            rc = RmRegisterResources(handle, (uint)resources.Length, resources, 0, null, 0, null);
            if (rc != 0) throw new Exception("RmRegisterResources failed: " + rc);

            uint pnProcInfoNeeded = 0, pnProcInfo = 0, rebootReasons = 0;
            rc = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, null, ref rebootReasons);
            if (rc == 234) {
                var info = new RM_PROCESS_INFO[pnProcInfoNeeded];
                pnProcInfo = pnProcInfoNeeded;
                rc = RmGetList(handle, out pnProcInfoNeeded, ref pnProcInfo, info, ref rebootReasons);
                if (rc == 0) {
                    for (int i = 0; i < pnProcInfo; i++) {
                        result.Add(info[i].Process.dwProcessId + "|" + info[i].strAppName + "|" + info[i].ApplicationType);
                    }
                } else throw new Exception("RmGetList(2) failed: " + rc);
            } else if (rc == 0) {
                // no locks
            } else throw new Exception("RmGetList failed: " + rc);
        } finally { RmEndSession(handle); }
        return result;
    }
}
'@

Add-Type -TypeDefinition $sig -Language CSharp
$lockers = [Rm]::WhoLocks($Path)
if ($lockers.Count -eq 0) { "NO LOCKERS FOUND for $Path" }
else {
    "LOCKERS for ${Path}:"
    foreach ($l in $lockers) {
        $parts = $l.Split('|')
        $p = Get-Process -Id ([int]$parts[0]) -ErrorAction SilentlyContinue
        "{0}  pid={1}  app={2}  type={3}  path={4}" -f $p.Name, $parts[0], $parts[1], $parts[2], $p.Path
    }
}
