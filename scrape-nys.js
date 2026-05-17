const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const NYS_URL = 'https://esupplier.sfs.ny.gov/psc/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL?PortalActualURL=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2fSUPPLIER%2fERP%2fc%2fNY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL&PortalContentURL=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2fSUPPLIER%2fERP%2fc%2fNY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL&PortalContentProvider=ERP&PortalCRefLabel=Search%20for%20Grant%20Opportunities&PortalRegistryName=SUPPLIER&PortalServletURI=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsp%2ffscm%2f&PortalURI=https%3a%2f%2fesupplier.sfs.ny.gov%2fpsc%2ffscm%2f&PortalHostNode=ERP&NoCrumbs=yes&PortalKeyStruct=yes';

const SFS_FALLBACK = 'https://esupplier.sfs.ny.gov/psp/fscm/SUPPLIER/ERP/c/NY_SUPPUB_FL.AUC_RESP_INQ_AUC.GBL';

async function loadSearchResults(page) {
  try {
    await page.goto(NYS_URL, { waitUntil: 'networkidle0', timeout: 60000 });
  } catch (e) {
    console.log('Nav note:', e.message);
  }
  await new Promise(r => setTimeout(r, 5000));

  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('input[type=submit], button, a'));
    const btn = btns.find(b => (b.value || b.innerText || '').trim().toLowerCase() === 'search');
    if (btn) btn.click();
  });
  await new Promise(r => setTimeout(r, 7000));
}

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log('Loading search results...');
  await loadSearchResults(page);

  // First pass: collect all grants and their row indices from the table
  const rawGrants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const colEventId = 0, colAgency = 1, colTitle = 2, colStatus = 3, colEligibility = 4, colDueDate = 7;

    for (const row of document.querySelectorAll('tr')) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 4) continue;

      const texts = cells.map(c => c.innerText.trim().replace(/\s+/g, ' ').split('\n')[0]);
      if (texts[0].toLowerCase().includes('event id') || texts[2]?.toLowerCase().includes('grant opportunity')) continue;

      const id = texts[colEventId];
      const agency = texts[colAgency];
      const title = texts[colTitle];
      const status = texts[colStatus];
      const eligibility = texts[colEligibility] || '';
      const dueDate = texts[colDueDate] || texts[6] || '';

      if (!id || id.length > 25 || !/^[A-Z]/.test(id)) continue;
      if (!title || title.length < 4 || title.length > 150) continue;
      if (seen.has(title)) continue;
      seen.add(title);

      const eligLower = eligibility.toLowerCase();
      if (eligLower && !eligLower.includes('governmental') && !eligLower.includes('government')) continue;

      // Extract the row index from the onclick e.g. 'AUC_NAME_LNK$0' -> 0
      const anchor = cells[colTitle]?.querySelector('a');
      const onclick = anchor ? (anchor.getAttribute('href') || '') : '';
      const rowMatch = onclick.match(/AUC_NAME_LNK\$(\d+)/);
      const rowIndex = rowMatch ? parseInt(rowMatch[1]) : null;

      results.push({ id, agency, title, status, eligibility, dueDate, rowIndex });
    }
    return results;
  });

  console.log('Found ' + rawGrants.length + ' grants — clicking into each detail page...');

  const grants = [];

  for (const g of rawGrants) {
    let announcementLink = SFS_FALLBACK;

    if (g.rowIndex !== null) {
      console.log('Clicking row ' + g.rowIndex + ' for [' + g.id + ']...');
      try {
        // Click the link using PeopleSoft's own function with the row index
        await page.evaluate((idx) => {
          const links = Array.from(document.querySelectorAll('a'));
          const link = links.find(a => (a.getAttribute('href') || '').includes('AUC_NAME_LNK$' + idx));
          if (link) link.click();
        }, g.rowIndex);

        await new Promise(r => setTimeout(r, 4000));

        // Extract the Announcement Link and Service Area from the detail page
        const found = await page.evaluate(() => {
          const result = { link: null, serviceArea: null };
          const allEls = Array.from(document.querySelectorAll('td, th, label, span, div'));

          // Grab Service Area(s)
          for (const el of allEls) {
            const text = (el.innerText || '').trim().toLowerCase();
            if (text.includes('service area')) {
              const parent = el.closest('tr') || el.parentElement;
              if (parent) {
                const next = parent.nextElementSibling;
                const candidates = [parent, next].filter(Boolean);
                for (const c of candidates) {
                  const cells = Array.from(c.querySelectorAll('td, span, div'));
                  for (const cell of cells) {
                    const val = (cell.innerText || '').trim();
                    if (val && val.length > 3 && !val.toLowerCase().includes('service area')) {
                      result.serviceArea = val;
                      break;
                    }
                  }
                  if (result.serviceArea) break;
                }
              }
            }
          }

          // Strategy 1: find Announcement Link
          for (const el of allEls) {
            const text = (el.innerText || '').trim().toLowerCase();
            if (text === 'announcement link' || text.includes('announcement link')) {
              const parent = el.closest('tr') || el.parentElement;
              if (parent) {
                const candidates = [parent, parent.nextElementSibling].filter(Boolean);
                for (const c of candidates) {
                  const links = Array.from(c.querySelectorAll('a[href]'));
                  const httpLink = links.find(a => a.href && a.href.startsWith('http') && !a.href.includes('javascript'));
                  if (httpLink) { result.link = httpLink.href.replace(/^https?:\/\/https?:\/+/, 'https://'); break; }
                }
              }
            }
          }
          // Strategy 2: any http link that is not SFS
          if (!result.link) {
            const allLinks = Array.from(document.querySelectorAll('a[href]'));
            const ext = allLinks.find(a =>
              a.href && a.href.startsWith('http') && !a.href.startsWith('mailto') &&
              !a.href.includes('esupplier.sfs.ny.gov') && !a.href.includes('javascript')
            );
            if (ext) result.link = ext.href.replace(/^https?:\/\/https?:\/+/, 'https://');
          }

          return result;
        });

        if (found.link) {
          announcementLink = found.link;
          console.log('  -> ' + announcementLink);
        } else {
          console.log('  -> No external link found, keeping SFS fallback');
        }
        if (found.serviceArea) {
          g.serviceArea = found.serviceArea;
          console.log('  -> Service Area: ' + found.serviceArea);
        }

        // Go back to search results for next iteration
        console.log('  Returning to search results...');
        await loadSearchResults(page);

      } catch (e) {
        console.log('  -> Error for [' + g.id + ']: ' + e.message);
        // Try to recover by reloading search results
        try { await loadSearchResults(page); } catch(_) {}
      }
    } else {
      console.log('[' + g.id + '] No row index found, skipping detail fetch');
    }

    grants.push({
      id: g.id,
      agency: g.agency,
      title: g.title,
      status: g.status,
      eligibility: g.eligibility,
      dueDate: g.dueDate,
      link: announcementLink,
      serviceArea: g.serviceArea || null,
      source: 'NYS',
    });
  }

  await browser.close();

  console.log('\nDone. ' + grants.length + ' grants processed.');
  grants.forEach(g => console.log(' - [' + g.id + '] ' + g.link));

  let manualGrants = [];
  const outputPath = path.join(process.cwd(), 'nys-grants.json');
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      manualGrants = (existing.grants || []).filter(g => g.manual === true);
      console.log('Preserving ' + manualGrants.length + ' manual entries');
    } catch(e) {
      console.log('Could not read existing file:', e.message);
    }
  }

  const allGrants = [...grants, ...manualGrants];
  const output = { grants: allGrants, fetched: new Date().toISOString(), count: allGrants.length };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('Saved.');
})();
