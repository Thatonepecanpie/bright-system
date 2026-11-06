// Screen-capture stand-in for OBS: record a page (a URL, a local dev server or a built-in demo) to WebM.
// Usage: NODE_PATH=$(npm root -g) node record.cjs <outDir> [url] [seconds=3]
// Tested 2026-11-06 with the container's preinstalled Playwright and Chromium. Convert with
// ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p out.mp4, and script clicks and scrolls with page.* calls.
const {chromium} = require('playwright');

(async () => {
  const [outDir = 'out/rec', url, seconds = '3'] = process.argv.slice(2);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: {width: 1280, height: 720},
    recordVideo: {dir: outDir, size: {width: 1280, height: 720}},
  });
  const page = await ctx.newPage();
  if (url) {
    await page.goto(url, {waitUntil: 'networkidle'});
  } else {
    await page.setContent(`<body style="margin:0;background:#111;display:grid;place-items:center;height:100vh">
      <div id=b style="width:120px;height:120px;border-radius:24px;background:#c6f432;
        transition:transform 1s cubic-bezier(.65,0,.35,1)"></div></body>`);
    await page.waitForTimeout(400);
    await page.evaluate(() => (document.getElementById('b').style.transform = 'translateX(300px) rotate(180deg)'));
  }
  await page.waitForTimeout(Number(seconds) * 1000);
  const video = page.video();
  await ctx.close();
  console.log('recorded', await video.path());
  await browser.close();
})();
