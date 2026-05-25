const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(distDir)) {
  process.exit(0);
}

const removablePattern = /^KakiMoni_Layout-.*-Setup\.exe(?:\.blockmap)?$/i;

for (const name of fs.readdirSync(distDir)) {
  if (!removablePattern.test(name)) continue;
  const fullPath = path.join(distDir, name);
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      fs.unlinkSync(fullPath);
      console.log(`[cleanup-dist] removed: ${name}`);
    }
  } catch (err) {
    console.warn(`[cleanup-dist] skipped: ${name} (${err.message})`);
  }
}
