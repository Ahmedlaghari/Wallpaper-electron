// Fonts bundled in /fonts. They are loaded privately by the app at runtime
// (FontFace in renderers, opentype.js outlines for static wallpapers) — nothing is
// installed into Windows.
// capsOnly: the font has no lowercase glyphs (previews show uppercase).
module.exports = [
    { family: "Anurati",            file: "anurati.ttf",                  category: "Futuristic", capsOnly: true },
    { family: "Orbitron",           file: "Orbitron-Regular.ttf",         category: "Futuristic" },
    { family: "Michroma",           file: "Michroma-Regular.ttf",         category: "Futuristic" },
    { family: "Syncopate",          file: "Syncopate-Bold.ttf",           category: "Futuristic" },
    { family: "Zen Dots",           file: "ZenDots-Regular.ttf",          category: "Futuristic" },
    { family: "Audiowide",          file: "Audiowide-Regular.ttf",        category: "Futuristic" },
    { family: "Russo One",          file: "RussoOne-Regular.ttf",         category: "Bold" },
    { family: "Bebas Neue",         file: "BebasNeue-Regular.ttf",        category: "Bold" },
    { family: "Bungee",             file: "Bungee-Regular.ttf",           category: "Bold" },
    { family: "Righteous",          file: "Righteous-Regular.ttf",        category: "Bold" },
    { family: "Monoton",            file: "Monoton-Regular.ttf",          category: "Neon" },
    { family: "Megrim",             file: "Megrim-Regular.ttf",           category: "Neon" },
    { family: "Rajdhani",           file: "Rajdhani-Bold.ttf",            category: "Clean" },
    { family: "Poppins",            file: "poppins.semibold.ttf",         category: "Clean" },
    { family: "Share Tech Mono",    file: "ShareTechMono-Regular.ttf",    category: "Mono" },
    { family: "Space Mono",         file: "SpaceMono-Bold.ttf",           category: "Mono" },
    { family: "Major Mono Display", file: "MajorMonoDisplay-Regular.ttf", category: "Mono" },
    { family: "Pacifico",           file: "Pacifico-Regular.ttf",         category: "Script" },
    { family: "Great Vibes",        file: "GreatVibes-Regular.ttf",       category: "Script" },
];
