const { chromium } = require('@playwright/test');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('https://geniusnotes-ai.vercel.app', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'C:/Users/nmntx/AppData/Local/Temp/verify1_initial.png' });

  const cardNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#tool-grid .tool-card .tcard-name')).map(el => el.textContent.trim())
  );
  console.log('DOM order:', JSON.stringify(cardNames));

  const structure = await page.evaluate(() => {
    const panel0 = document.querySelector('#conv-track > .conv-panel');
    return {
      vidInPanel0: !!panel0?.querySelector('.vid-showcase'),
      searchInPanel0: !!panel0?.querySelector('#yt-search-section'),
    };
  });
  console.log('Structure:', JSON.stringify(structure));

  const ytOrder = await page.evaluate(() => document.querySelector('#tool-grid .tool-card[style*="order:8"], #tool-grid .tool-card[style*="order: 8"]')?.querySelector('.tcard-name')?.textContent);
  const lyricsOrder = await page.evaluate(() => document.querySelector('#tool-grid .tool-card[style*="order:9"], #tool-grid .tool-card[style*="order: 9"]')?.querySelector('.tcard-name')?.textContent);
  console.log('Card with order:8:', ytOrder, '| Card with order:9:', lyricsOrder);

  await page.evaluate(() => document.querySelector('#youtube-summarizer').scrollIntoView());
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'C:/Users/nmntx/AppData/Local/Temp/verify2_toolarea.png' });

  // Switch to Highlighter (DOM index 1)
  const cards = await page.$$('#tool-grid .tool-card');
  await cards[1].click();
  await page.waitForTimeout(700);
  const transform = await page.evaluate(() => document.querySelector('#conv-track').style.transform);
  console.log('Transform after Highlighter click:', transform);
  await page.screenshot({ path: 'C:/Users/nmntx/AppData/Local/Temp/verify3_highlighter.png' });

  await browser.close();
  console.log('Done');
})().catch(e => { console.error(e.message); process.exit(1); });
