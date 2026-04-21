const { app, Tray, Menu, BrowserWindow, ipcMain, dialog, Notification } = require("electron");
const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage, registerFont } = require("canvas");
const { autoUpdater } = require("electron-updater");

const bgPathFile = path.join(app.getPath("userData"), "bgpath.txt");
const configPath = path.join(app.getPath("userData"), "config.json");

ipcMain.on("reload-wallpaper", async () => {
    await generateWallpaper();
});

async function getImage() {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog({
        filters: [{ name: "Images", extensions: ["jpg", "png"] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        fs.writeFileSync(bgPathFile, result.filePaths[0]);
    }
}

function ensureConfigExists() {
    if (!fs.existsSync(configPath)) {
        const defaultConfig = {
            clockAnchor: "middle-center",
            clockOffsetX: 0,
            clockOffsetY: 0,

            dayFont: "Anurati",
            daySize: 110,
            daySpacing: 10,
            dayY: -270,

            dateFont: "Rajdhani",
            dateSize: 45,
            dateY: -170,

            timeFont: "Rajdhani",
            timeSize: 50,
            timeY: -80,
            timePrefix: "- ",
            timeSuffix: " -",
            hour12: true,

            fontColor: "white",
            shadowEnabled: true,
            shadowColor: "black",
            shadowBlur: 40,

            canvasWidth: 1920,
            canvasHeight: 1200
        };
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    }
}

function getClockBase(config, width, height) {
    const anchor = config.clockAnchor || "middle-center";
    const offsetX = Number(config.clockOffsetX) || 0;
    const offsetY = Number(config.clockOffsetY) || 0;

    const [vAnchor, hAnchor] = anchor.split("-");

    let baseX, baseY, textAlign;

    if (hAnchor === "left") {
        baseX = Math.round(width * 0.08) + offsetX;
        textAlign = "left";
    } else if (hAnchor === "right") {
        baseX = Math.round(width * 0.92) + offsetX;
        textAlign = "right";
    } else {
        baseX = Math.round(width / 2) + offsetX;
        textAlign = "center";
    }

    if (vAnchor === "top") {
        baseY = Math.round(height * 0.15) + offsetY;
    } else if (vAnchor === "bottom") {
        baseY = Math.round(height * 0.82) + offsetY;
    } else {
        baseY = Math.round(height / 2) + offsetY;
    }

    return { baseX, baseY, textAlign };
}

async function generateWallpaper() {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const selectedImagePath = fs.readFileSync(bgPathFile, "utf-8").trim();

    if (!selectedImagePath) {
        console.log("No image selected");
        return;
    }

    const bgImage = await loadImage(selectedImagePath);
    const { execSync } = require("child_process");

    function setWallpaper(imagePath) {
        const escaped = imagePath.replace(/'/g, "''");
        const script = `Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class Wallpaper {
    [DllImport("user32.dll")]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@
[Wallpaper]::SystemParametersInfo(20, 0, '${escaped}', 3)`;

        const scriptPath = path.join(app.getPath("temp"), "set-wallpaper.ps1");
        fs.writeFileSync(scriptPath, script, "utf-8");
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`);
    }

    const width = config.canvasWidth || 1920;
    const height = config.canvasHeight || 1200;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(bgImage, 0, 0, width, height);

    const now = new Date();
    const day = now.toLocaleDateString("en-US", { weekday: "long" });
    const date = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const time = now.toLocaleTimeString("en-US", {
        hour: "2-digit", minute: "2-digit", hour12: config.hour12 !== false
    });

    const { baseX, baseY, textAlign } = getClockBase(config, width, height);

    ctx.fillStyle = config.fontColor || "white";
    ctx.textBaseline = "alphabetic";

    if (config.shadowEnabled !== false) {
        ctx.shadowBlur = config.shadowBlur || 40;
        ctx.shadowColor = config.shadowColor || "black";
    } else {
        ctx.shadowBlur = 0;
        ctx.shadowColor = "transparent";
    }

    // Draw day name with manual letter spacing
    const text = day.toUpperCase();
    const letterSpacing = Number(config.daySpacing ?? 10);
    ctx.font = `${config.daySize || 110}px ${config.dayFont || "Anurati"}`;

    let totalWidth = 0;
    for (let i = 0; i < text.length; i++) {
        totalWidth += ctx.measureText(text[i]).width;
    }
    totalWidth += letterSpacing * (text.length - 1);

    let startX;
    if (textAlign === "left") {
        startX = baseX;
    } else if (textAlign === "right") {
        startX = baseX - totalWidth;
    } else {
        startX = baseX - totalWidth / 2;
    }

    const dayDrawY = baseY + (config.dayY ?? -270);
    let x = startX;
    for (let i = 0; i < text.length; i++) {
        ctx.fillText(text[i], x, dayDrawY);
        x += ctx.measureText(text[i]).width + letterSpacing;
    }

    // Date and time are always centered on the day text's midpoint
    const dayCenterX = startX + totalWidth / 2;

    ctx.textAlign = "center";

    ctx.font = `${config.dateSize || 45}px ${config.dateFont || "Rajdhani"}`;
    ctx.fillText(date, dayCenterX, baseY + (config.dateY ?? -170));

    ctx.font = `${config.timeSize || 50}px ${config.timeFont || "Rajdhani"}`;
    ctx.fillText(
        (config.timePrefix ?? "- ") + time + (config.timeSuffix ?? " -"),
        dayCenterX,
        baseY + (config.timeY ?? -80)
    );

    const buffer = canvas.toBuffer("image/png");
    const filePath = path.join(app.getPath("userData"), "wallpaper.png");
    fs.writeFileSync(filePath, buffer);

    setWallpaper(filePath);
}

function scheduleNextUpdate() {
    const now = new Date();
    const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(async () => {
        await generateWallpaper();
        scheduleNextUpdate();
    }, delay);
}

let settingsWindow = null;

function openSettings() {
    if (settingsWindow) { settingsWindow.focus(); return; }

    settingsWindow = new BrowserWindow({
        width: 500,
        height: 820,
        resizable: false,
        title: "Wallpaper Settings",
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    settingsWindow.loadFile("settings.html");
    settingsWindow.on("closed", () => { settingsWindow = null; });
}

let tray = null;
let updateReady = false;

function buildTrayMenu() {
    const template = [
        { label: "Change Background", click: async () => {
            await getImage();
            await generateWallpaper();
        }},
        { type: "separator" },
        { label: "Settings", click: () => openSettings() },
        { label: "Reload Wallpaper", click: async () => { await generateWallpaper(); }},
        { type: "separator" },
    ];

    if (updateReady) {
        template.push({ label: "Restart to Install Update", click: () => autoUpdater.quitAndInstall() });
        template.push({ type: "separator" });
    } else {
        template.push({ label: "Check for Updates", click: () => {
            if (!app.isPackaged) {
                dialog.showMessageBox({ message: "Updates only work in the packaged app.", buttons: ["OK"] });
                return;
            }
            autoUpdater.checkForUpdates();
        }});
    }

    template.push({ label: "Quit", click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(template));
}

function setupAutoUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
        console.log("Update available:", info.version);
        if (Notification.isSupported()) {
            new Notification({
                title: "Time Wallpaper",
                body: `v${info.version} is downloading in the background.`
            }).show();
        }
    });

    autoUpdater.on("update-downloaded", (info) => {
        console.log("Update downloaded:", info.version);
        updateReady = true;
        buildTrayMenu();
        if (Notification.isSupported()) {
            new Notification({
                title: "Time Wallpaper",
                body: `v${info.version} ready — right-click the tray icon to restart and install.`
            }).show();
        }
    });

    autoUpdater.on("error", (err) => {
        console.error("Auto-update error:", err.message);
    });

    // Check on startup, then every 4 hours
    autoUpdater.checkForUpdates().catch(e => console.error("Update check failed:", e));
    setInterval(() => autoUpdater.checkForUpdates().catch(e => console.error(e)), 4 * 60 * 60 * 1000);
}

app.whenReady().then(async () => {
    // Create tray first so it always appears even if later steps fail
    ensureConfigExists();
    tray = new Tray(path.join(__dirname, "icon.png"));

    const fontsDir = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'fonts')
        : path.join(__dirname, 'fonts');

    const anuratiPath = path.join(fontsDir, 'anurati.ttf');
    const rajdhaniPath = path.join(fontsDir, 'Rajdhani-Bold.ttf');
    const poppinsPath = path.join(fontsDir, 'poppins.semibold.ttf');

    console.log('Fonts dir:', fontsDir);
    console.log('Anurati exists:', fs.existsSync(anuratiPath));
    console.log('Rajdhani exists:', fs.existsSync(rajdhaniPath));
    console.log('Poppins exists:', fs.existsSync(poppinsPath));

    try {
        registerFont(poppinsPath, { family: 'Poppins' });
        registerFont(anuratiPath, { family: 'Anurati' });
        registerFont(rajdhaniPath, { family: 'Rajdhani' });
    } catch (e) {
        console.error('Font registration error:', e);
    }

    tray.setToolTip("Time Wallpaper");
    buildTrayMenu();
    ipcMain.handle("get-user-data-path", () => app.getPath("userData"));

    try { await generateWallpaper(); } catch (e) { console.error('Wallpaper error:', e); }
    scheduleNextUpdate();

    if (app.isPackaged) setupAutoUpdater();

    app.on("window-all-closed", (e) => { e.preventDefault(); });
});
