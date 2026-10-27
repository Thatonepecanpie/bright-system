// Bundles the dashboard into one self-contained page for claude.ai: inline CSS and JS, and the
// Supabase-connector transport in place of HTTP. Output: build/company-floor.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('public/index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/\s*<script[^>]*><\/script>/g, '');
const noClose = (js) => js.replace(/<\/script/gi, '<\\/script');

const page = `<title>Company Floor</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&family=Public+Sans:wght@400;600;700&display=swap">
<style>
${read('public/style.css')}
</style>
${body.trim()}
<script>
window.BOARD_API = 'https://qwnkqpaloygtgvvwtalu.supabase.co/functions/v1/board';
${noClose(read('public/claude-transport.js'))}
</script>
<script>
${noClose(read('public/confetti.js'))}
</script>
<script>
${noClose(read('public/office.js'))}
</script>
<script>
${noClose(read('public/sprite-maker.js'))}
</script>
<script>
${noClose(read('public/home.js'))}
</script>
<script>
${noClose(read('public/app.js'))}
</script>
`;

mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
writeFileSync(new URL('../build/company-floor.html', import.meta.url), page);
console.log(`build/company-floor.html: ${page.length} bytes`);
