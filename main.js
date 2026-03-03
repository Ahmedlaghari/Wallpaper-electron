const { app, Tray, Menu, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage, registerFont } = require("canvas");

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
    const configPath = path.join(app.getPath("userData"), "config.json");

    if (!fs.existsSync(configPath)) {
        const defaultConfig = {
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
            shadowColor: "black",
            shadowBlur: 40,

            canvasWidth: 1920,
            canvasHeight: 1200
        };

        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
    }
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

    ctx.fillStyle = config.fontColor || "white"

    ctx.shadowBlur = config.shadowBlur || 40;
    ctx.shadowColor = config.shadowColor || "black";
    ctx.font = `${config.daySize || 110}px ${config.dayFont || "Anurati"}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    const text = day.toUpperCase();
    const letterSpacing = config.daySpacing ?? 10; // spacing in pixels



// Start drawing from left so text stays centered
// Measure total width with same rounding as render loop
    let totalWidth = 0;
    for (let i = 0; i < text.length; i++) {
        totalWidth += ctx.measureText(text[i]).width;
    }
    totalWidth += letterSpacing * (text.length - 1);

    let x = Math.round((width / 2) - (totalWidth / 2));
    let increment = Math.round(totalWidth/text.length)// no rounding here
    const y = height / 2 + (config.dayY || -270);

    for (let i = 0; i < text.length; i++) {
        ctx.fillText(text[i], Math.round(x), y);  // round only at draw time
        x += increment;
    }
    // ctx.font = `${config.daySize || 110}px ${config.dayFont || "Anurati"}`;
    // const spacedDay = day.toUpperCase().split("").join(config.daySpacing || " ");
    // ctx.fillText(spacedDay, width / 2, height / 2 + (config.dayY || -270));
    ctx.textAlign = "center";

    ctx.font = `${config.dateSize || 45}px ${config.dateFont || "Rajdhani"}`;
    ctx.fillText(date, width / 2, height / 2 + (config.dateY || -170));

    ctx.font = `${config.timeSize || 50}px ${config.timeFont || "Rajdhani"}`;
    ctx.fillText((config.timePrefix || "- ") + time + (config.timeSuffix || " -"), width / 2, height / 2 + (config.timeY || -80));

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
        height: 700,
        resizable: false,
        title: "Wallpaper Settings",
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    settingsWindow.loadFile("settings.html");
    settingsWindow.on("closed", () => { settingsWindow = null; });
}

let tray = null;

app.whenReady().then(async () => {
    // Register fonts FIRST, before anything else
    const fontsDir = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'fonts')
        : path.join(__dirname, 'fonts');

    registerFont(path.join(fontsDir, 'poppins.semibold.ttf'), { family: 'Poppins' });
    ensureConfigExists();
    tray = new Tray(path.join(__dirname, "icon.png"));
    const anuratiPath = path.join(fontsDir, 'anurati.ttf');
    const rajdhaniPath = path.join(fontsDir, 'Rajdhani-Bold.ttf');
    const poppinsPath = path.join(fontsDir, 'poppins.semibold.ttf');

    console.log('Fonts dir:', fontsDir);
    console.log('Anurati exists:', fs.existsSync(anuratiPath));
    console.log('Rajdhani exists:', fs.existsSync(rajdhaniPath));
    console.log('Poppins exists:', fs.existsSync(poppinsPath));
    registerFont(anuratiPath, { family: 'Anurati' });
    registerFont(path.join(fontsDir, 'poppins.semibold.ttf'), { family: 'Poppins' });
    registerFont(rajdhaniPath, { family: 'Rajdhani' });

    const contextMenu = Menu.buildFromTemplate([
        { label: "Change Background", click: async () => {

                await getImage();
                await generateWallpaper();
            }},
        { type: "separator" },
        { label: "Settings", click: () => openSettings() },
        { label: "Reload Wallpaper", click: async () => { await generateWallpaper(); }},
        { type: "separator" },
        { label: "Quit", click: () => app.quit() }
    ]);

    tray.setToolTip("Time Wallpaper");
    tray.setContextMenu(contextMenu);
    ipcMain.handle("get-user-data-path", () => {
        return app.getPath("userData");
    });


    await generateWallpaper();
    scheduleNextUpdate();
    app.on("window-all-closed", (e) => {
        e.preventDefault();
    });
});