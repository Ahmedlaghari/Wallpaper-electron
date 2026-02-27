const { app } = require("electron");
const fs = require("fs");
const path = require("path");
// const { createCanvas, registerFont} = require("canvas");
const { createCanvas, loadImage,registerFont } = require("canvas");
registerFont(path.join(__dirname, "fonts/anurati.otf"), {
    family: "Anurati"
});

registerFont(path.join(__dirname, "fonts/poppins.semibold.ttf"), {
    family: "Poppins"
});
let selectedImagePath = null;

async function getImage() {
    const { dialog } = require("electron");

    const result = await dialog.showOpenDialog({
        filters: [{ name: "Images", extensions: ["jpg", "png"] }]
    });
    if (!result.canceled && result.filePaths.length > 0) {
        selectedImagePath = result.filePaths[0];
    }
}
async function generateWallpaper() {
    if (!selectedImagePath) {
        console.log("No image selected");
        return;
    }

    const bgImage = await loadImage(selectedImagePath);
    const wallpaper = await import("wallpaper");

    const width = 1920;
    const height = 1200;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(bgImage, 0, 0, width, height);
    const now = new Date();

    const day = now.toLocaleDateString("en-US", {
        weekday: "long"
    });

    const date = now.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric"
    });

    const time = now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });

    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.shadowColor = "black";
    ctx.shadowBlur = 40;

// 🔥 DAY (Top - Anurati)
    ctx.font = "140px Anurati";

    ctx.fillText(day.toUpperCase(), width / 2, height / 2 - 250,10000);

// 🔥 DATE (Middle - Poppins)
    ctx.font = "70px Poppins";
    ctx.fillText(date, width / 2, height / 2 - 120);

// 🔥 TIME (Bottom - Poppins Bold Style)
    ctx.font = "80px Poppins";
    ctx.fillText(time, width / 2, height / 2 + 80);

    const buffer = canvas.toBuffer("image/png");
    const filePath = path.join(app.getPath("userData"), "wallpaper.png");
    fs.writeFileSync(filePath, buffer);

    await wallpaper.setWallpaper(filePath);
}

app.whenReady().then(async() => {
    await getImage();

    // Generate wallpaper after selecting image
    await generateWallpaper();

    // Update every minute
    setInterval(generateWallpaper, 60000);
});