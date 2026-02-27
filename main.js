const { app, Tray, Menu, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage, registerFont } = require("canvas");

registerFont(path.join(__dirname, "fonts/Anurati-Regular.otf"), { family: "Anurati" });
registerFont(path.join(__dirname, "fonts/Rajdhani-Bold.ttf"), { family: "Rajdhani" });

const bgPathFile = path.join(app.getPath("userData"), "bgpath.txt");
const configPath = path.join(__dirname, "config.json");

ipcMain.on("reload-wallpaper", async () => {
    await generateWallpaper();
});

async function getImage() {
    if (fs.existsSync(bgPathFile)) return;

    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog({
        filters: [{ name: "Images", extensions: ["jpg", "png"] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        fs.writeFileSync(bgPathFile, result.filePaths[0]);
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
    const wallpaper = await import("wallpaper");

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

    ctx.fillStyle = config.fontColor || "white";
    ctx.textAlign = "center";
    ctx.shadowBlur = config.shadowBlur || 40;
    ctx.shadowColor = config.shadowColor || "black";

    ctx.font = `${config.daySize || 110}px ${config.dayFont || "Anurati"}`;
    const spacedDay = day.toUpperCase().split("").join(config.daySpacing || " ");
    ctx.fillText(spacedDay, width / 2, height / 2 + (config.dayY || -270));

    ctx.font = `${config.dateSize || 45}px ${config.dateFont || "Rajdhani"}`;
    ctx.fillText(date, width / 2, height / 2 + (config.dateY || -170));

    ctx.font = `${config.timeSize || 50}px ${config.timeFont || "Rajdhani"}`;
    ctx.fillText((config.timePrefix || "- ") + time + (config.timeSuffix || " -"), width / 2, height / 2 + (config.timeY || -80));

    const buffer = canvas.toBuffer("image/png");
    const filePath = path.join(app.getPath("userData"), "wallpaper.png");
    fs.writeFileSync(filePath, buffer);

    await wallpaper.setWallpaper(filePath);
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
    tray = new Tray(path.join(__dirname, "icon.png"));

    const contextMenu = Menu.buildFromTemplate([
        { label: "Change Background", click: async () => {
                fs.unlinkSync(bgPathFile);
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

    await getImage();
    await generateWallpaper();
    scheduleNextUpdate();
});