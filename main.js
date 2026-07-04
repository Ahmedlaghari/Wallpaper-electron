const {
    app, Tray, Menu, BrowserWindow, ipcMain,
    dialog, Notification, screen, powerMonitor
} = require("electron");
const fs   = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { createCanvas, loadImage, registerFont } = require("canvas");
const { autoUpdater } = require("electron-updater");
const execFileAsync = promisify(execFile);

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

function writeConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Packaged builds ship fonts via extraResources (resources/fonts);
// in development they live next to the sources.
function getFontsDir() {
    return app.isPackaged
        ? path.join(process.resourcesPath, "fonts")
        : path.join(__dirname, "fonts");
}

// ─── Config ───────────────────────────────────────────────────────────────────
function ensureConfigExists() {
    if (fs.existsSync(configPath)) return;
    const defaultConfig = {
        // Clock visibility & layout
        clockEnabled:  true,
        clockAnchor:   "middle-center",
        clockOffsetX:  0,
        clockOffsetY:  0,

        // Day text
        dayFont:    "Anurati",
        daySize:    110,
        daySpacing: 10,
        dayY:       -270,

        // Date text
        dateFont: "Rajdhani",
        dateSize: 45,
        dateY:    -170,

        // Time text
        timeFont:   "Rajdhani",
        timeSize:   50,
        timeY:      -80,
        timePrefix: "- ",
        timeSuffix: " -",
        hour12:     true,
        showSeconds: false,

        // Clock style
        fontColor:     "white",
        shadowEnabled: true,
        shadowColor:   "black",
        shadowBlur:    40,

        // Static wallpaper timing
        interval:     60,
        canvasWidth:  1920,
        canvasHeight: 1080,

        // Video wallpaper
        videoEnabled: false,
        videoPath:    "",
        videoVolume:  0,
        videoLoop:    true,

        // Live wallpaper (persisted so it survives app restarts)
        liveEnabled: false,
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

// ─── Wallpaper API (static mode) ─────────────────────────────────────────────
async function setDesktopWallpaper(imagePath, options = {}) {
    if (!wallpaperApi) wallpaperApi = await import("wallpaper");
    await wallpaperApi.setWallpaper(imagePath, options);
}

function drawImageCover(ctx, image, x, y, width, height) {
    const imageRatio  = image.width / image.height;
    const targetRatio = width / height;
    let sourceX = 0, sourceY = 0;
    let sourceWidth = image.width, sourceHeight = image.height;

    if (imageRatio > targetRatio) {
        sourceWidth = Math.round(image.height * targetRatio);
        sourceX     = Math.round((image.width - sourceWidth) / 2);
    } else {
        sourceHeight = Math.round(image.width / targetRatio);
        sourceY      = Math.round((image.height - sourceHeight) / 2);
    }
    ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

async function setWindowsPerMonitorWallpapers(monitorMap) {
    // monitorMap: array of { bounds: {x,y,w,h}, imagePath }
    // We pass the data as JSON so PowerShell can match each monitor by its
    // physical rect (from GetMonitorRECT) instead of assuming left-to-right order.
    const monitorMapJson = JSON.stringify(
        monitorMap.map(m => ({
            x: m.bounds.x, y: m.bounds.y,
            w: m.bounds.w, h: m.bounds.h,
            path: m.imagePath
        }))
    ).replace(/'/g, "''");

    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public enum DesktopWallpaperPosition { Center=0, Tile=1, Stretch=2, Fit=3, Fill=4, Span=5 }

[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
    void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID,
                      [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
    [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper(
        [MarshalAs(UnmanagedType.LPWStr)] string monitorID);
    [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
    uint GetMonitorDevicePathCount();
    void GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID, out WallRect displayRect);
    void SetBackgroundColor(uint color);
    uint GetBackgroundColor();
    void SetPosition(DesktopWallpaperPosition position);
    DesktopWallpaperPosition GetPosition();
    void SetSlideshow(IntPtr items);
    IntPtr GetSlideshow();
    void SetSlideshowOptions(uint options, uint slideshowTick);
    void GetSlideshowOptions(out uint options, out uint slideshowTick);
    void AdvanceSlideshow([MarshalAs(UnmanagedType.LPWStr)] string monitorID, uint direction);
    uint GetStatus();
    bool Enable(bool enable);
}

[StructLayout(LayoutKind.Sequential)]
public struct WallRect { public int Left, Top, Right, Bottom; }

public static class WallpaperHelper {
    static readonly Guid CLSID = new Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD");
    static readonly Guid IID   = new Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B");

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter,
        uint dwClsContext, ref Guid riid, out IntPtr ppv);

    public static IDesktopWallpaper Create() {
        Guid clsid = CLSID, iid = IID;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out IntPtr ppv);
        if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        var obj = Marshal.GetObjectForIUnknown(ppv);
        Marshal.Release(ppv);
        return (IDesktopWallpaper)obj;
    }
}
"@ -ErrorAction Stop

\$wallpaper = [WallpaperHelper]::Create()
\$wallpaper.SetPosition([DesktopWallpaperPosition]::Fill)

# Parse the monitor map passed from Node
\$monitorMap = '${monitorMapJson}' | ConvertFrom-Json
\$count = [int]\$wallpaper.GetMonitorDevicePathCount()

for (\$i = 0; \$i -lt \$count; \$i++) {
    \$monitorId = \$wallpaper.GetMonitorDevicePathAt([uint32]\$i)
    \$rect = New-Object WallRect
    \$wallpaper.GetMonitorRECT(\$monitorId, [ref]\$rect)

    # Find the matching entry in our map by comparing physical bounds.
    # A tolerance of 8px handles any DPI rounding between Electron and Windows.
    \$match = \$monitorMap | Where-Object {
        [Math]::Abs(\$_.x - \$rect.Left)   -le 8 -and
        [Math]::Abs(\$_.y - \$rect.Top)    -le 8 -and
        [Math]::Abs(\$_.w - (\$rect.Right  - \$rect.Left)) -le 8 -and
        [Math]::Abs(\$_.h - (\$rect.Bottom - \$rect.Top))  -le 8
    } | Select-Object -First 1

    if (\$match) {
        Write-Host "Monitor \$i (\$(\$rect.Left),\$(\$rect.Top)) -> \$(\$match.path)"
        \$wallpaper.SetWallpaper(\$monitorId, \$match.path)
    } else {
        Write-Host "Monitor \$i (\$(\$rect.Left),\$(\$rect.Top)) -> no match, skipping"
    }
}
`;
    await execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script
    ], { windowsHide: true });
}

// ─── Static wallpaper generation ─────────────────────────────────────────────
async function generateWallpaper() {
    const config            = readConfig();
    const selectedImagePath = readBackgroundPath();

    if (!selectedImagePath) {
        console.log("No background image selected — skipping wallpaper generation.");
        return;
    }

    if (!fs.existsSync(selectedImagePath)) {
        console.warn("Background image no longer exists — skipping wallpaper generation:", selectedImagePath);
        return;
    }

    if (cachedBgPath !== selectedImagePath || !cachedBgImage) {
        console.log("Loading background image:", selectedImagePath);
        cachedBgPath  = selectedImagePath;
        cachedBgImage = await loadImage(selectedImagePath);
        console.log("Background image loaded:", cachedBgImage.width, "x", cachedBgImage.height);
    }

    wallpaperWriteIndex = (wallpaperWriteIndex + 1) % 2;
    const displays   = getSortedDisplays();
    const monitorMap = [];   // { bounds, imagePath } — used by Windows path
    const outputPaths = [];  // ordered list — used by macOS/Linux path

    for (let i = 0; i < displays.length; i++) {
        const display     = displays[i];
        const scaleFactor = display.scaleFactor || 1;
        const width       = Math.round(display.bounds.width  * scaleFactor);
        const height      = Math.round(display.bounds.height * scaleFactor);

        console.log(
            `Static wallpaper display ${display.id}: ${width}x${height} physical px ` +
            `(logical=${display.bounds.width}x${display.bounds.height}, scale=${scaleFactor}) ` +
            `origin=(${display.bounds.x},${display.bounds.y})`
        );

        const canvas = createCanvas(width, height);
        const ctx    = canvas.getContext("2d");
        drawImageCover(ctx, cachedBgImage, 0, 0, width, height);
        if (config.clockEnabled !== false) _drawClock(ctx, config, width, height);

        const filePath = path.join(app.getPath("userData"), `wallpaper-${wallpaperWriteIndex}-display-${i}.jpeg`);
        const tmpPath  = filePath + ".tmp";
        fs.writeFileSync(tmpPath, canvas.toBuffer("image/jpeg", { quality: 0.95 }));
        fs.renameSync(tmpPath, filePath);
        outputPaths.push(filePath);

        // Store the logical bounds (x/y/w/h) so PowerShell can match this image
        // to the correct monitor via GetMonitorRECT, regardless of physical order.
        monitorMap.push({
            bounds: {
                x: display.bounds.x,
                y: display.bounds.y,
                w: display.bounds.width,
                h: display.bounds.height,
            },
            imagePath: filePath,
        });

        console.log("Wallpaper written to", filePath);
    }

    if (process.platform === "win32") {
        await setWindowsPerMonitorWallpapers(monitorMap);
    } else if (process.platform === "darwin") {
        await Promise.all(outputPaths.map((fp, i) => setDesktopWallpaper(fp, { screen: i, scale: "fill" })));
    } else {
        await setDesktopWallpaper(outputPaths[0], { scale: "fill" });
    }

    console.log(`Applied ${outputPaths.length} wallpaper(s).`);
}

function _drawClock(ctx, config, width, height) {
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

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on("reload-wallpaper", async () => {
    if (liveWindows.length > 0) refreshLiveWallpaper();
    else await runWallpaperUpdate();
});

ipcMain.on("settings-updated", () => {
    startStaticUpdates();
    refreshLiveWallpaper();
});

ipcMain.handle("get-user-data-path",      () => app.getPath("userData"));
ipcMain.handle("get-live-wallpaper-data", event => getLiveWallpaperData(event.sender));

// ─── Background / video picker ────────────────────────────────────────────────
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

async function pickVideoWallpaper() {
    const result = await dialog.showOpenDialog({
        title: "Select Video Wallpaper",
        filters: [{ name: "Videos", extensions: ["mp4", "webm", "mov", "mkv"] }]
    });
    if (result.canceled || !result.filePaths.length) return;

    const videoPath = result.filePaths[0];
    const config    = readConfig();
    config.videoEnabled = true;
    config.videoPath    = videoPath;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log("Video wallpaper set to:", videoPath);
    return videoPath;
}

// ─── Live wallpaper data ──────────────────────────────────────────────────────
function getLiveWallpaperData(sender = null) {
    const fontsDir = getFontsDir();

    const allDisplays = getSortedDisplays();
    const virtualBounds = getVirtualBounds(allDisplays);
    const targetWindow = sender ? BrowserWindow.fromWebContents(sender) : null;
    const targetDisplayId = targetWindow?.liveDisplayId;
    const targetDisplay = targetDisplayId
        ? allDisplays.find(d => String(d.id) === String(targetDisplayId))
        : null;

    if (targetDisplay) {
        const display = {
            id:          targetDisplay.id,
            bounds:      { x: 0, y: 0, width: targetDisplay.bounds.width, height: targetDisplay.bounds.height },
            scaleFactor: targetDisplay.scaleFactor,
            offsetX:     0,
            offsetY:     0,
            physicalWidth:  Math.round(targetDisplay.bounds.width  * targetDisplay.scaleFactor),
            physicalHeight: Math.round(targetDisplay.bounds.height * targetDisplay.scaleFactor),
        };

        return {
            config:         readConfig(),
            backgroundPath: readBackgroundPath(),
            virtualBounds:   { x: 0, y: 0, width: targetDisplay.bounds.width, height: targetDisplay.bounds.height },
            display,
            displays: [display],
            fonts: {
                anurati:  path.join(fontsDir, "anurati.ttf"),
                rajdhani: path.join(fontsDir, "Rajdhani-Bold.ttf"),
                poppins:  path.join(fontsDir, "poppins.semibold.ttf")
            }
        };
    }

    const displays = allDisplays.map(d => ({
        id:          d.id,
        bounds:      d.bounds,
        scaleFactor: d.scaleFactor,
        offsetX:     Math.round(d.bounds.x - virtualBounds.x),
        offsetY:     Math.round(d.bounds.y - virtualBounds.y),
        physicalWidth:  Math.round(d.bounds.width  * d.scaleFactor),
        physicalHeight: Math.round(d.bounds.height * d.scaleFactor),
    }));

    return {
        config:         readConfig(),
        backgroundPath: readBackgroundPath(),
        virtualBounds,
        displays,
        fonts: {
            anurati:  path.join(fontsDir, "anurati.ttf"),
            rajdhani: path.join(fontsDir, "Rajdhani-Bold.ttf"),
            poppins:  path.join(fontsDir, "poppins.semibold.ttf")
        }
    };
}

// ─── electron-as-wallpaper ────────────────────────────────────────────────────
const { attach, detach } = require("electron-as-wallpaper");

function attachWindowToDesktop(win) {
    if (process.platform !== "win32") return;
    if (win.isAttachedToDesktop) return;
    if (win.isDestroyed())       return;

    try {
        attach(win, { transparent: true });
        win.isAttachedToDesktop = true;
        // SetParent reinterprets the window's coordinates relative to WorkerW's
        // client area, whose origin is the virtual screen's top-left — which is
        // negative when a monitor sits left of/above the primary.  Re-apply the
        // bounds in WorkerW-relative coordinates or the window lands shifted by
        // one monitor.
        win.setBounds(toWorkerWRelativeBounds(getTargetBoundsForLiveWindow(win)));
        console.log(`[attach] SUCCESS display=${win.liveDisplayId}`);
    } catch (e) {
        console.error(`[attach] FAILED display=${win.liveDisplayId}:`, e.message);
        win.isAttachedToDesktop = false;
    }
}

// ─── Display helpers ──────────────────────────────────────────────────────────
function getSortedDisplays() {
    return screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

// ─── Virtual desktop bounds ───────────────────────────────────────────────────
function getVirtualBounds(displays = screen.getAllDisplays()) {
    const left   = Math.min(...displays.map(d => d.bounds.x));
    const top    = Math.min(...displays.map(d => d.bounds.y));
    const right  = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
    const bottom = Math.max(...displays.map(d => d.bounds.y + d.bounds.height));
    return {
        x:      Math.round(left),
        y:      Math.round(top),
        width:  Math.round(right  - left),
        height: Math.round(bottom - top),
    };
}

// ─── Live wallpaper – maintenance ────────────────────────────────────────────
function getTargetBoundsForLiveWindow(win) {
    const display = getDisplayForLiveWindow(win);
    return display ? display.bounds : getVirtualBounds();
}

// Once a window is parented into WorkerW, SetWindowPos coordinates are
// relative to WorkerW's client area (origin = virtual screen top-left),
// not the screen.  Translate screen bounds accordingly.
function toWorkerWRelativeBounds(bounds) {
    const virtual = getVirtualBounds();
    return {
        x:      bounds.x - virtual.x,
        y:      bounds.y - virtual.y,
        width:  bounds.width,
        height: bounds.height,
    };
}

function maintainLiveWallpaperWindow(win) {
    if (win.isDestroyed()) return;

    // win.getBounds() reports screen coordinates even after reparenting,
    // so compare against the screen-space target to detect drift.
    const target  = getTargetBoundsForLiveWindow(win);
    const current = win.getBounds();
    const drifted =
        Math.abs(current.x      - target.x)      > 2 ||
        Math.abs(current.y      - target.y)      > 2 ||
        Math.abs(current.width  - target.width)  > 2 ||
        Math.abs(current.height - target.height) > 2;

    if (drifted) {
        console.log(`[maintain] bounds drifted (${JSON.stringify(current)} → ${JSON.stringify(target)}) — re-applying`);
        win.setBounds(win.isAttachedToDesktop ? toWorkerWRelativeBounds(target) : target);
    }

    if (win.isMinimized()) {
        console.log("[maintain] live window minimized — restoring");
        win.restore();
    }

    if (!win.isVisible()) {
        console.log("[maintain] live window hidden — showing");
        win.showInactive();
    }

    if (!win.isAttachedToDesktop) {
        console.log("[maintain] live window not attached — attaching");
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

function getDisplayForLiveWindow(win) {
    const targetId = win?.liveDisplayId;
    if (!targetId || targetId === "virtual-desktop") return null;
    return screen.getAllDisplays().find(d => String(d.id) === String(targetId)) || null;
}

// ─── Live wallpaper – per-display windows ─────────────────────────────────────
function createLiveWallpaperWindow(display) {
    const bounds = display.bounds;
    console.log(`Creating live wallpaper window for display id=${display.id} bounds=${JSON.stringify(bounds)} scale=${display.scaleFactor}`);

    const win = new BrowserWindow({
        x:      bounds.x,
        y:      bounds.y,
        width:  bounds.width,
        height: bounds.height,
        useContentSize: false,
        frame:          false,
        resizable:      false,
        movable:        false,
        minimizable:    false,
        maximizable:    false,
        skipTaskbar:    true,
        show:           false,
        focusable:      false,
        fullscreenable: false,
        transparent:    true,
        webPreferences: {
            nodeIntegration:      true,
            contextIsolation:     false,
            backgroundThrottling: false,
        }
    });

    win.liveDisplayId       = display.id;
    win.isAttachedToDesktop = false;

    win.setMenu(null);
    win.setIgnoreMouseEvents(true);
    win.loadFile("live.html");

    win.once("ready-to-show", () => {
        console.log(`[win event] ready-to-show display=${win.liveDisplayId} — affirming bounds and showing`);
        const b = getDisplayForLiveWindow(win)?.bounds || bounds;
        win.setBounds(b);
        win.showInactive();
    });

    win.on("restore", () => {
        console.log(`[win event] restore display=${win.liveDisplayId} — resetting attach flag`);
        win.isAttachedToDesktop = false;
        setTimeout(() => maintainLiveWallpaperWindow(win), 300);
    });

    win.on("closed", () => {
        console.log("[win event] closed");
        liveWindows = liveWindows.filter(w => w !== win);
        if (liveWindows.length === 0) stopLiveWallpaperMaintenance();
        buildTrayMenu();
    });

    return win;
}

// ─── Live wallpaper – start / stop ───────────────────────────────────────────

async function waitForVisibleThenAttach(win) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        if (win.isDestroyed()) return;
        if (win.isVisible()) {
            attachWindowToDesktop(win);
            return;
        }
        await wait(100);
    }
    console.warn("[attach] window never became visible — skipping");
}

async function startLiveWallpaper() {
    if (liveWindows.length > 0) { console.log("startLiveWallpaper: already running."); return; }
    console.log("Starting live wallpaper...");
    stopStaticUpdates();

    const virtualBounds = getVirtualBounds();

    // One window spanning the whole virtual desktop.  Monitors left of/above the
    // primary (negative coordinates) are fine: attachWindowToDesktop re-applies
    // the bounds in WorkerW-relative coordinates after reparenting.
    const win = createLiveWallpaperWindow({ id: "virtual-desktop", bounds: virtualBounds, scaleFactor: 1 });
    liveWindows = [win];

    await waitForVisibleThenAttach(win);
    startLiveWallpaperMaintenance();
    buildTrayMenu();
}

function stopLiveWallpaper() {
    if (liveWindows.length === 0) { console.log("stopLiveWallpaper: not running."); return; }
    console.log("Stopping live wallpaper...");
    const windowsToClose = [...liveWindows];
    liveWindows = [];
    stopLiveWallpaperMaintenance();

    windowsToClose.forEach(win => {
        if (win.isDestroyed()) return;
        try {
            detach(win);
            console.log(`[detach] display=${win.liveDisplayId}`);
        } catch (e) {
            console.warn(`[detach] failed display=${win.liveDisplayId}:`, e.message);
        }
        win.close();
    });

    void runWallpaperUpdate();
    startStaticUpdates();
    buildTrayMenu();
}

function setLiveEnabled(enabled) {
    const config = readConfig();
    config.liveEnabled = enabled;
    writeConfig(config);
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
    setTimeout(startLiveWallpaper, 1500);
}

function reattachLiveWallpaperWindows() {
    console.log("Power resume/unlock — resetting attachment flags.");
    liveWindows.forEach(win => {
        if (win.isDestroyed()) return;
        win.isAttachedToDesktop = false;
        if (!win.isVisible())  win.showInactive();
        if (win.isMinimized()) win.restore();
    });
    setTimeout(maintainLiveWallpaperWindows, 800);
}

// ─── Settings window ──────────────────────────────────────────────────────────
function openSettings() {
    if (settingsWindow) { settingsWindow.focus(); return; }
    settingsWindow = new BrowserWindow({
        width: 520, height: 900, resizable: false,
        title: "Wallpaper Settings",
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    settingsWindow.loadFile("settings.html");
    settingsWindow.on("closed", () => { settingsWindow = null; });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
    if (!tray || tray.isDestroyed()) return;
    const isLive   = liveWindows.length > 0;
    const config   = readConfig();
    const template = [
        {
            label: "Change Background Image",
            click: async () => {
                await getImage();
                if (isLive) refreshLiveWallpaper();
                else await runWallpaperUpdate();
            }
        },
        {
            label: "Set Video Wallpaper…",
            click: async () => {
                const videoPath = await pickVideoWallpaper();
                if (!videoPath) return;
                if (isLive) {
                    stopLiveWallpaper();
                    setTimeout(startLiveWallpaper, 800);
                } else {
                    // A video wallpaper only plays in live mode — start it.
                    setLiveEnabled(true);
                    startLiveWallpaper();
                }
            }
        },
        {
            label: config.videoEnabled ? "Disable Video Wallpaper" : "Enable Video Wallpaper",
            click: () => {
                const cfg = readConfig();
                cfg.videoEnabled = !cfg.videoEnabled;
                fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
                if (isLive) refreshLiveWallpaper();
                buildTrayMenu();
            }
        },
        { type: "separator" },
        { label: "Settings",        click: () => openSettings() },
        {
            label: "Reload Wallpaper",
            click: async () => {
                if (isLive) refreshLiveWallpaper();
                else await runWallpaperUpdate();
            }
        },
        isLive
            ? { label: "Stop Live Wallpaper",  click: () => { setLiveEnabled(false); stopLiveWallpaper();  } }
            : { label: "Start Live Wallpaper", click: () => { setLiveEnabled(true);  startLiveWallpaper(); } },
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
            new Notification({ title: "Live Wallpaper", body: `v${info.version} is downloading.` }).show();
    });

    autoUpdater.on("download-progress", p => console.log(`Update: ${Math.round(p.percent)}%`));

    autoUpdater.on("update-downloaded", info => {
        console.log("Update downloaded:", info.version);
        updateDownloading = false; updateReady = true;
        buildTrayMenu();
        if (Notification.isSupported())
            new Notification({
                title: "Live Wallpaper",
                body:  `v${info.version} ready — right-click tray to install.`
            }).show();
    });

    autoUpdater.on("error", e => {
        console.error("Auto-update error:", e.message);
        updateDownloading = false;
        buildTrayMenu();
        if (Notification.isSupported())
            new Notification({ title: "Live Wallpaper update failed", body: e.message || "Could not download update." }).show();
    });

    autoUpdater.checkForUpdates().catch(e => console.error("Update check failed:", e));
    setInterval(() => autoUpdater.checkForUpdates().catch(e => console.error(e)), 4 * 60 * 60 * 1000);
}

app.commandLine.appendSwitch("disable-gpu-compositing");

// ─── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    console.log("App ready.");
    ensureConfigExists();

    tray = new Tray(path.join(__dirname, "icon.png"));
    tray.setToolTip("Live Wallpaper");
    buildTrayMenu();
    console.log("Tray created.");

    const fontsDir = getFontsDir();

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

    // Resume whichever mode was active last time the app ran.
    if (readConfig().liveEnabled) {
        try { await startLiveWallpaper(); }
        catch (e) { console.error("Live wallpaper autostart error:", e); }
    } else {
        try { await runWallpaperUpdate(); }
        catch (e) { console.error("Initial wallpaper error:", e); }
        startStaticUpdates();
    }

    if (app.isPackaged) setupAutoUpdater();

    screen.on("display-added",           restartLiveWallpaperForDisplays);
    screen.on("display-removed",         restartLiveWallpaperForDisplays);
    screen.on("display-metrics-changed", restartLiveWallpaperForDisplays);

    powerMonitor.on("resume",        reattachLiveWallpaperWindows);
    powerMonitor.on("unlock-screen", reattachLiveWallpaperWindows);

    app.on("window-all-closed", e => e.preventDefault());

    console.log("Startup complete.");
});

// Detach live windows before quitting so the desktop is left in a clean
// state (otherwise WorkerW can keep showing a stale frame of the window).
app.on("before-quit", () => {
    stopLiveWallpaperMaintenance();
    const windowsToClose = [...liveWindows];
    liveWindows = [];
    windowsToClose.forEach(win => {
        if (win.isDestroyed()) return;
        try { detach(win); } catch (e) { console.warn("[quit] detach failed:", e.message); }
        win.destroy();
    });
});