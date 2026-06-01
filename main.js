const {
    app, Tray, Menu, BrowserWindow, ipcMain,
    dialog, Notification, screen, powerMonitor
} = require("electron");
const fs   = require("fs");
const path = require("path");
const { createCanvas, loadImage, registerFont } = require("canvas");
const { autoUpdater } = require("electron-updater");

// ─── Paths ────────────────────────────────────────────────────────────────────
const bgPathFile  = path.join(app.getPath("userData"), "bgpath.txt");
const configPath  = path.join(app.getPath("userData"), "config.json");

// ─── State ────────────────────────────────────────────────────────────────────
let wallpaperApi              = null;
let cachedBgPath              = null;
let cachedBgImage             = null;
let wallpaperWriteIndex       = 0;
let wallpaperUpdateInProgress = false;

let updateTimer                   = null;
let liveWindows                   = [];
let liveWallpaperMaintenanceTimer = null;

let tray              = null;
let settingsWindow    = null;
let updateReady       = false;
let updateDownloading = false;

// ─── Logging ──────────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────────
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function readConfig() {
    try { return JSON.parse(fs.readFileSync(configPath, "utf-8")); }
    catch (e) { console.error("readConfig failed:", e.message); return {}; }
}

function readBackgroundPath() {
    try { return fs.readFileSync(bgPathFile, "utf-8").trim(); }
    catch { return ""; }
}

// ─── Config ───────────────────────────────────────────────────────────────────
function ensureConfigExists() {
    if (fs.existsSync(configPath)) return;
    const defaultConfig = {
        clockAnchor:   "middle-center",
        clockOffsetX:  0,
        clockOffsetY:  0,
        dayFont:    "Anurati",
        daySize:    110,
        daySpacing: 10,
        dayY:       -270,
        dateFont: "Rajdhani",
        dateSize: 45,
        dateY:    -170,
        timeFont:   "Rajdhani",
        timeSize:   50,
        timeY:      -80,
        timePrefix: "- ",
        timeSuffix: " -",
        hour12:     true,
        fontColor:     "white",
        shadowEnabled: true,
        shadowColor:   "black",
        shadowBlur:    40,
        interval:     60,
        canvasWidth:  1920,
        canvasHeight: 1200
    };
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    console.log("Created default config at", configPath);
}

// ─── Clock layout ─────────────────────────────────────────────────────────────
function getClockBase(config, width, height) {
    const anchor  = config.clockAnchor || "middle-center";
    const offsetX = Number(config.clockOffsetX) || 0;
    const offsetY = Number(config.clockOffsetY) || 0;
    const [vAnchor, hAnchor] = anchor.split("-");
    let baseX, baseY, textAlign;
    if (hAnchor === "left") {
        baseX = Math.round(width * 0.08) + offsetX; textAlign = "left";
    } else if (hAnchor === "right") {
        baseX = Math.round(width * 0.92) + offsetX; textAlign = "right";
    } else {
        baseX = Math.round(width / 2) + offsetX; textAlign = "center";
    }
    if (vAnchor === "top")         baseY = Math.round(height * 0.15) + offsetY;
    else if (vAnchor === "bottom") baseY = Math.round(height * 0.82) + offsetY;
    else                           baseY = Math.round(height / 2) + offsetY;
    return { baseX, baseY, textAlign };
}

// ─── Wallpaper API ────────────────────────────────────────────────────────────
async function setDesktopWallpaper(imagePath) {
    if (!wallpaperApi) wallpaperApi = await import("wallpaper");
    await wallpaperApi.setWallpaper(imagePath);
}

// ─── Static wallpaper generation ─────────────────────────────────────────────
async function generateWallpaper() {
    const config            = readConfig();
    const selectedImagePath = readBackgroundPath();

    if (!selectedImagePath) {
        console.log("No background image selected — skipping wallpaper generation.");
        return;
    }

    if (cachedBgPath !== selectedImagePath || !cachedBgImage) {
        console.log("Loading background image:", selectedImagePath);
        cachedBgPath  = selectedImagePath;
        cachedBgImage = await loadImage(selectedImagePath);
        console.log("Background image loaded. Size:", cachedBgImage.width, "x", cachedBgImage.height);
    }

    const width  = config.canvasWidth  || 1920;
    const height = config.canvasHeight || 1200;
    const canvas = createCanvas(width, height);
    const ctx    = canvas.getContext("2d");
    ctx.drawImage(cachedBgImage, 0, 0, width, height);

    const now  = new Date();
    const day  = now.toLocaleDateString("en-US", { weekday: "long" });
    const date = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const time = now.toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: config.hour12 !== false
    });

    const { baseX, baseY, textAlign } = getClockBase(config, width, height);
    ctx.fillStyle    = config.fontColor || "white";
    ctx.textBaseline = "alphabetic";

    if (config.shadowEnabled !== false) {
        ctx.shadowBlur  = config.shadowBlur || 40;
        ctx.shadowColor = config.shadowColor || "black";
    } else {
        ctx.shadowBlur  = 0;
        ctx.shadowColor = "transparent";
    }

    const text          = day.toUpperCase();
    const letterSpacing = Number(config.daySpacing ?? 10);
    ctx.font            = `${config.daySize || 110}px "${config.dayFont || "Anurati"}"`;

    let totalWidth = 0;
    for (let i = 0; i < text.length; i++) totalWidth += ctx.measureText(text[i]).width;
    totalWidth += letterSpacing * (text.length - 1);

    let startX;
    if (textAlign === "left")       startX = baseX;
    else if (textAlign === "right") startX = baseX - totalWidth;
    else                            startX = baseX - totalWidth / 2;

    const dayDrawY = baseY + (config.dayY ?? -270);
    let x = startX;
    for (let i = 0; i < text.length; i++) {
        ctx.fillText(text[i], x, dayDrawY);
        x += ctx.measureText(text[i]).width + letterSpacing;
    }

    const dayCenterX = startX + totalWidth / 2;
    ctx.textAlign    = "center";
    ctx.font = `${config.dateSize || 45}px "${config.dateFont || "Rajdhani"}"`;
    ctx.fillText(date, dayCenterX, baseY + (config.dateY ?? -170));
    ctx.font = `${config.timeSize || 50}px "${config.timeFont || "Rajdhani"}"`;
    ctx.fillText(
        (config.timePrefix ?? "- ") + time + (config.timeSuffix ?? " -"),
        dayCenterX,
        baseY + (config.timeY ?? -80)
    );

    wallpaperWriteIndex = (wallpaperWriteIndex + 1) % 2;
    const filePath = path.join(app.getPath("userData"), `wallpaper-${wallpaperWriteIndex}.jpeg`);
    const tmpPath  = filePath + ".tmp";
    fs.writeFileSync(tmpPath, canvas.toBuffer("image/jpeg"));
    fs.renameSync(tmpPath, filePath);
    console.log("Wallpaper written to", filePath);

    await setDesktopWallpaper(filePath);
    console.log("Wallpaper applied.");
}

// ─── Run / schedule static updates ───────────────────────────────────────────
async function runWallpaperUpdate({ skipIfBusy = false } = {}) {
    if (skipIfBusy && wallpaperUpdateInProgress) {
        console.log("Wallpaper update skipped (busy).");
        return;
    }
    while (wallpaperUpdateInProgress) await wait(50);
    wallpaperUpdateInProgress = true;
    try {
        await generateWallpaper();
    } finally {
        wallpaperUpdateInProgress = false;
    }
}

function stopStaticUpdates() {
    if (!updateTimer) return;
    clearInterval(updateTimer);
    updateTimer = null;
    console.log("Static updates stopped.");
}

function startStaticUpdates() {
    stopStaticUpdates();
    const config          = readConfig();
    const intervalSeconds = Number.parseInt(config.interval, 10);
    const delay           = Math.max(1, Number.isFinite(intervalSeconds) ? intervalSeconds : 60) * 1000;
    console.log(`Static updates scheduled every ${delay / 1000}s.`);
    updateTimer = setInterval(async () => {
        if (liveWindows.length > 0) return;
        try { await runWallpaperUpdate({ skipIfBusy: true }); }
        catch (e) { console.error("Scheduled wallpaper update failed:", e); }
    }, delay);
}

function scheduleNextUpdate() { startStaticUpdates(); }

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on("reload-wallpaper", async () => {
    console.log("IPC: reload-wallpaper");
    if (liveWindows.length > 0) refreshLiveWallpaper();
    else await runWallpaperUpdate();
});

ipcMain.on("settings-updated", () => {
    console.log("IPC: settings-updated");
    startStaticUpdates();
    refreshLiveWallpaper();
});

ipcMain.handle("get-user-data-path",      () => app.getPath("userData"));
ipcMain.handle("get-live-wallpaper-data", () => getLiveWallpaperData());

// ─── Background picker ────────────────────────────────────────────────────────
async function getImage() {
    const result = await dialog.showOpenDialog({
        filters: [{ name: "Images", extensions: ["jpg", "png"] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        fs.writeFileSync(bgPathFile, result.filePaths[0]);
        cachedBgPath  = null;
        cachedBgImage = null;
        console.log("Background image set to:", result.filePaths[0]);
    }
}

// ─── Live wallpaper data ──────────────────────────────────────────────────────
function getLiveWallpaperData() {
    const fontsDir = app.isPackaged
        ? path.join(process.resourcesPath, "app.asar.unpacked", "fonts")
        : path.join(__dirname, "fonts");
    return {
        config:         readConfig(),
        backgroundPath: readBackgroundPath(),
        fonts: {
            anurati:  path.join(fontsDir, "anurati.ttf"),
            rajdhani: path.join(fontsDir, "Rajdhani-Bold.ttf"),
            poppins:  path.join(fontsDir, "poppins.semibold.ttf")
        }
    };
}

// ─── Live wallpaper – Windows desktop attachment ──────────────────────────────
function getWindowHandle(win) {
    const handle = win.getNativeWindowHandle();
    return (process.arch === "x64")
        ? handle.readBigUInt64LE(0).toString()
        : handle.readUInt32LE(0).toString();
}

function getDisplayForLiveWindow(win) {
    const displays = screen.getAllDisplays();
    return displays.find(d => d.id === win.liveDisplayId)
        || screen.getDisplayMatching(win.getBounds());
}

function attachWindowToDesktop(win) {
    if (process.platform !== "win32") {
        console.log("Non-win32 platform — skipping desktop attach.");
        return;
    }
    if (win.isAttachedToDesktop) return;
    win.isAttachedToDesktop = true;

    const { execFile } = require("child_process");
    const bounds = win.getBounds();
    const hwnd   = getWindowHandle(win);

    console.log(`[attach] display=${win.liveDisplayId} hwnd=${hwnd} bounds=${JSON.stringify(bounds)}`);

    // No JS interpolation inside the PS script body — pass everything as -Args
    // to avoid conflicts between JS ${...} and PowerShell ${...} syntax
    const script = `param($hwnd, $bx, $by, $bw, $bh)
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class DesktopWindow {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
}
"@

# FindWindow can fail when called from a child process of Electron.
# FindWindowEx with IntPtr.Zero parent searches all top-level windows reliably.
$progman = [DesktopWindow]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, "Progman", $null)
Write-Host "[PS] Progman: $progman"
if ($progman -eq [IntPtr]::Zero) {
    Write-Host "[PS] ERROR: Could not find Progman - aborting"
    exit 1
}

$result = [IntPtr]::Zero
[DesktopWindow]::SendMessageTimeout($progman, 0x052C, [IntPtr]::Zero, [IntPtr]::Zero, 0, 1000, [ref]$result) | Out-Null
Write-Host "[PS] SendMessageTimeout done"

$script:workerw = [IntPtr]::Zero
$callback = [DesktopWindow+EnumWindowsProc] {
    param([IntPtr]$topHandle, [IntPtr]$topParam)
    $defView = [DesktopWindow]::FindWindowEx($topHandle, [IntPtr]::Zero, "SHELLDLL_DefView", $null)
    if ($defView -ne [IntPtr]::Zero) {
        $script:workerw = [DesktopWindow]::FindWindowEx([IntPtr]::Zero, $topHandle, "WorkerW", $null)
        Write-Host "[PS] Found WorkerW: $($script:workerw)"
    }
    return $true
}

[DesktopWindow]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($script:workerw -eq [IntPtr]::Zero) {
    Write-Host "[PS] WorkerW not found - falling back to Progman"
    $script:workerw = $progman
} else {
    Write-Host "[PS] Using WorkerW: $($script:workerw)"
}

$target = [IntPtr][long]$hwnd
Write-Host "[PS] Target HWND: $target"

$setParentResult = [DesktopWindow]::SetParent($target, $script:workerw)
Write-Host "[PS] SetParent result: $setParentResult"

[DesktopWindow]::ShowWindow($target, 5) | Out-Null
Write-Host "[PS] ShowWindow done"

# Step 1: Register as TOPMOST — IShellDispatch.MinimizeAll (Show Desktop gesture)
# skips windows that have the TOPMOST bit set in their Z-order metadata.
# HWND_TOPMOST = -1, flags = SWP_NOMOVE|SWP_NOSIZE (0x0010|0x0001 = 0x0011)
$topmostResult = [DesktopWindow]::SetWindowPos($target, [IntPtr](-1), $bx, $by, $bw, $bh, 0x0011)
Write-Host "[PS] SetWindowPos TOPMOST result: $topmostResult"

# Step 2: Push back to HWND_BOTTOM so it sits behind all other windows.
# HWND_BOTTOM = 1, flags = SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE (0x0010|0x0001|0x0040 = 0x0051)
# The TOPMOST registration survives this — Windows keeps it in the topmost
# band even when z-ordered to the bottom of that band.
$bottomResult = [DesktopWindow]::SetWindowPos($target, [IntPtr](1), $bx, $by, $bw, $bh, 0x0051)
Write-Host "[PS] SetWindowPos BOTTOM result: $bottomResult"

# Apply WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST to extended styles
# so the shell permanently treats this as a non-managed desktop-layer window
$GWL_EXSTYLE      = -20
$WS_EX_TOOLWINDOW = 0x00000080
$WS_EX_NOACTIVATE = 0x08000000
$WS_EX_TOPMOST    = 0x00000008
$current = [DesktopWindow]::GetWindowLong($target, $GWL_EXSTYLE)
Write-Host "[PS] Current ExStyle: $current"
$newStyle = $current -bor $WS_EX_TOOLWINDOW -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOPMOST
$setStyleResult = [DesktopWindow]::SetWindowLong($target, $GWL_EXSTYLE, $newStyle)
Write-Host "[PS] SetWindowLong result: $setStyleResult (new=$newStyle)"
`;

    const scriptPath = path.join(app.getPath("temp"), `tw-live-${hwnd}.ps1`);
    console.log(`[attach] Writing PS script to: ${scriptPath}`);
    fs.writeFileSync(scriptPath, script, "utf-8");

    // SysNative resolves to 64-bit System32 even when Node is 32-bit.
    // Without this, spawning 'powershell.exe' from a 64-bit Electron process
    // can land in SysWOW64 (32-bit PS) which cannot see 64-bit windows like Progman.
    const ps64 = "C:\\Windows\\SysNative\\WindowsPowerShell\\v1.0\\powershell.exe";
    const psExe = fs.existsSync(ps64) ? ps64 : "powershell.exe";
    console.log(`[attach] Using PowerShell: ${psExe}`);

    execFile(
        psExe,
        [
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", scriptPath,
            "-hwnd", hwnd,
            "-bx", String(bounds.x),
            "-by", String(bounds.y),
            "-bw", String(bounds.width),
            "-bh", String(bounds.height)
        ],
        { timeout: 15000 },
        (psErr, stdout, stderr) => {
            if (stdout) console.log(`[PS stdout]\n${stdout.trim()}`);
            if (stderr) console.warn(`[PS stderr]\n${stderr.trim()}`);
            if (psErr) {
                console.error(`[attach] FAILED for display ${win.liveDisplayId}:`, psErr.message);
                win.isAttachedToDesktop = false;
            } else {
                console.log(`[attach] SUCCESS for display ${win.liveDisplayId}`);
            }
        }
    );
}

// ─── Live wallpaper – maintenance ────────────────────────────────────────────
function maintainLiveWallpaperWindow(win) {
    if (win.isDestroyed()) return;

    const display     = getDisplayForLiveWindow(win);
    const bounds      = display.bounds;
    win.liveDisplayId = display.id;

    const wasMinimized = win.isMinimized();
    const wasHidden    = !win.isVisible();

    if (wasMinimized) { console.log(`[maintain] display=${win.liveDisplayId} was minimized — restoring`); win.restore(); }
    if (wasHidden)    { console.log(`[maintain] display=${win.liveDisplayId} was hidden — showing`);      win.showInactive(); }

    win.setBounds(bounds);

    if (!win.isAttachedToDesktop) {
        console.log(`[maintain] display=${win.liveDisplayId} not attached — running attach`);
        attachWindowToDesktop(win);
    }
}

function maintainLiveWallpaperWindows() {
    liveWindows.forEach(maintainLiveWallpaperWindow);
}

function startLiveWallpaperMaintenance() {
    if (liveWallpaperMaintenanceTimer || liveWindows.length === 0) return;
    console.log("Starting live wallpaper maintenance timer (5s).");
    liveWallpaperMaintenanceTimer = setInterval(maintainLiveWallpaperWindows, 5000);
    if (liveWallpaperMaintenanceTimer.unref) liveWallpaperMaintenanceTimer.unref();
}

function stopLiveWallpaperMaintenance() {
    if (!liveWallpaperMaintenanceTimer) return;
    clearInterval(liveWallpaperMaintenanceTimer);
    liveWallpaperMaintenanceTimer = null;
    console.log("Live wallpaper maintenance timer stopped.");
}

// ─── Live wallpaper – window creation ────────────────────────────────────────
function createLiveWallpaperWindow(display) {
    const bounds = display.bounds;
    console.log(`Creating live wallpaper window for display ${display.id} bounds=${JSON.stringify(bounds)}`);

    const win = new BrowserWindow({
        x: bounds.x, y: bounds.y,
        width: bounds.width, height: bounds.height,
        frame:          false,
        resizable:      false,
        movable:        false,
        minimizable:    false,
        maximizable:    false,
        skipTaskbar:    true,
        show:           false,
        focusable:      false,
        fullscreenable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
    });

    win.liveDisplayId       = display.id;
    win.isAttachedToDesktop = false;

    win.setMenu(null);
    win.setIgnoreMouseEvents(true);
    win.loadFile("live.html");

    win.once("ready-to-show", () => {
        console.log(`[win event] ready-to-show for display ${win.liveDisplayId}`);
        maintainLiveWallpaperWindow(win);
    });

    win.on("show", () => {
        console.log(`[win event] show for display ${win.liveDisplayId}`);
    });

    win.on("hide", () => {
        console.log(`[win event] hide for display ${win.liveDisplayId} — calling showInactive`);
        win.showInactive();
    });

    win.on("minimize", event => {
        console.log(`[win event] minimize for display ${win.liveDisplayId} — preventing and restoring`);
        event.preventDefault();
        win.restore();
        win.showInactive();
    });

    win.on("restore", () => {
        console.log(`[win event] restore for display ${win.liveDisplayId}`);
    });

    win.on("closed", () => {
        console.log(`[win event] closed for display ${win.liveDisplayId}`);
        liveWindows = liveWindows.filter(w => w !== win);
        if (liveWindows.length === 0) stopLiveWallpaperMaintenance();
        buildTrayMenu();
    });

    return win;
}

// ─── Live wallpaper – start / stop ───────────────────────────────────────────
function startLiveWallpaper() {
    if (liveWindows.length > 0) { console.log("startLiveWallpaper: already running."); return; }
    console.log("Starting live wallpaper...");
    stopStaticUpdates();
    liveWindows = screen.getAllDisplays().map(d => createLiveWallpaperWindow(d));
    console.log(`Created ${liveWindows.length} live window(s).`);
    startLiveWallpaperMaintenance();
    buildTrayMenu();
}

function stopLiveWallpaper() {
    if (liveWindows.length === 0) { console.log("stopLiveWallpaper: not running."); return; }
    console.log("Stopping live wallpaper...");
    const windowsToClose = [...liveWindows];
    liveWindows = [];
    stopLiveWallpaperMaintenance();
    windowsToClose.forEach(win => { if (!win.isDestroyed()) win.close(); });
    void runWallpaperUpdate();
    startStaticUpdates();
    buildTrayMenu();
}

function refreshLiveWallpaper() {
    console.log("Refreshing live wallpaper settings...");
    liveWindows.forEach(win => {
        if (!win.isDestroyed()) win.webContents.send("live-settings-updated");
    });
}

function restartLiveWallpaperForDisplays() {
    if (liveWindows.length === 0) return;
    console.log("Display change detected — restarting live wallpaper.");
    stopLiveWallpaper();
    startLiveWallpaper();
}

function reattachLiveWallpaperWindows() {
    console.log("Power resume/unlock — resetting attachment flags and reattaching.");
    liveWindows.forEach(win => {
        if (!win.isDestroyed()) win.isAttachedToDesktop = false;
    });
    maintainLiveWallpaperWindows();
}

// ─── Settings window ──────────────────────────────────────────────────────────
function openSettings() {
    if (settingsWindow) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({
        width: 500, height: 820, resizable: false,
        title: "Wallpaper Settings",
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    settingsWindow.loadFile("settings.html");
    settingsWindow.on("closed", () => { settingsWindow = null; });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
    const template = [
        {
            label: "Change Background",
            click: async () => {
                await getImage();
                if (liveWindows.length > 0) refreshLiveWallpaper();
                else await runWallpaperUpdate();
            }
        },
        { type: "separator" },
        { label: "Settings",        click: () => openSettings() },
        {
            label: "Reload Wallpaper",
            click: async () => {
                if (liveWindows.length > 0) refreshLiveWallpaper();
                else await runWallpaperUpdate();
            }
        },
        liveWindows.length > 0
            ? { label: "Stop Live Wallpaper",  click: () => stopLiveWallpaper() }
            : { label: "Start Live Wallpaper", click: () => startLiveWallpaper() },
        { type: "separator" }
    ];

    if (updateReady) {
        template.push({ label: "Restart to Install Update", click: () => autoUpdater.quitAndInstall() });
        template.push({ type: "separator" });
    } else if (updateDownloading) {
        template.push({ label: "Downloading Update…", enabled: false });
        template.push({ type: "separator" });
    } else {
        template.push({
            label: "Check for Updates",
            click: () => {
                if (!app.isPackaged) {
                    dialog.showMessageBox({ message: "Updates only work in the packaged app.", buttons: ["OK"] });
                    return;
                }
                autoUpdater.checkForUpdates();
            }
        });
    }

    template.push({ label: "Quit", click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(template));
}

// ─── Auto-updater ─────────────────────────────────────────────────────────────
function setupAutoUpdater() {
    autoUpdater.autoDownload         = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", info => {
        console.log("Update available:", info.version);
        updateDownloading = true;
        buildTrayMenu();
        if (Notification.isSupported())
            new Notification({ title: "Time Wallpaper", body: `v${info.version} is downloading in the background.` }).show();
    });

    autoUpdater.on("download-progress", p => console.log(`Update download: ${Math.round(p.percent)}%`));

    autoUpdater.on("update-downloaded", info => {
        console.log("Update downloaded:", info.version);
        updateDownloading = false; updateReady = true;
        buildTrayMenu();
        if (Notification.isSupported())
            new Notification({
                title: "Time Wallpaper",
                body:  `v${info.version} ready – right-click tray icon to restart and install.`
            }).show();
    });

    autoUpdater.on("error", e => {
        console.error("Auto-update error:", e.message);
        updateDownloading = false;
        buildTrayMenu();
        if (Notification.isSupported())
            new Notification({ title: "Time Wallpaper update failed", body: e.message || "Could not download update." }).show();
    });

    autoUpdater.checkForUpdates().catch(e => console.error("Update check failed:", e));
    setInterval(() => autoUpdater.checkForUpdates().catch(e => console.error(e)), 4 * 60 * 60 * 1000);
}

// ─── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    console.log("App ready.");
    ensureConfigExists();

    tray = new Tray(path.join(__dirname, "icon.png"));
    tray.setToolTip("Time Wallpaper");
    buildTrayMenu();
    console.log("Tray created.");

    const fontsDir   = app.isPackaged
        ? path.join(process.resourcesPath, "app.asar.unpacked", "fonts")
        : path.join(__dirname, "fonts");

    const anuratiPath  = path.join(fontsDir, "anurati.ttf");
    const rajdhaniPath = path.join(fontsDir, "Rajdhani-Bold.ttf");
    const poppinsPath  = path.join(fontsDir, "poppins.semibold.ttf");

    console.log("Fonts dir:", fontsDir);
    console.log("Anurati exists:",  fs.existsSync(anuratiPath));
    console.log("Rajdhani exists:", fs.existsSync(rajdhaniPath));
    console.log("Poppins exists:",  fs.existsSync(poppinsPath));

    try {
        registerFont(poppinsPath,  { family: "Poppins" });
        registerFont(anuratiPath,  { family: "Anurati" });
        registerFont(rajdhaniPath, { family: "Rajdhani" });
        console.log("Fonts registered.");
    } catch (e) { console.error("Font registration error:", e); }

    try { await runWallpaperUpdate(); }
    catch (e) { console.error("Initial wallpaper error:", e); }

    startStaticUpdates();

    if (app.isPackaged) setupAutoUpdater();

    screen.on("display-added",           restartLiveWallpaperForDisplays);
    screen.on("display-removed",         restartLiveWallpaperForDisplays);
    screen.on("display-metrics-changed", restartLiveWallpaperForDisplays);

    powerMonitor.on("resume",        reattachLiveWallpaperWindows);
    powerMonitor.on("unlock-screen", reattachLiveWallpaperWindows);

    app.on("window-all-closed", e => e.preventDefault());

    console.log("Startup complete.");
});