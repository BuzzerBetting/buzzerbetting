/*** CONFIG ***/
const SHEET_NAME = 'Accounts';   // tab name — change if yours differs
const AUTOFILL_ROW = 1;          // row of tickboxes: TRUE = this bookie participates in "no specific book" autofill
const HEADER_ROW = 2;            // row containing bookie names (col A = "Account", B.. = bookies)
const FIRST_DATA_ROW = 3;        // first row containing a profile name

const COLOR_UNTESTED = '#fce8b2'; // orange — matches your existing "In Progress" convention

/*** SECURITY ***
 * Set the secret once via: Project Settings (gear icon) -> Script Properties -> Add property
 *   Property: ACCOUNTS_API_KEY
 *   Value:    <a long random string, share only with the Netlify function>
 * Every request must include a matching "secret" field in the POST body.
 */
function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('ACCOUNTS_API_KEY');
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const expected = getSecret_();
    if (!expected) return respond({ ok: false, error: 'ACCOUNTS_API_KEY not set in Script Properties' });
    if (body.secret !== expected) return respond({ ok: false, error: 'Unauthorized' });

    const bookie = (body.bookie || '').trim();
    const anyAutofill = !!body.anyAutofill;
    const names = Array.isArray(body.names) ? body.names.map(n => String(n).trim()).filter(n => n) : [];
    if (!names.length) return respond({ ok: false, error: 'at least one name is required' });
    if (!bookie && !anyAutofill) return respond({ ok: false, error: 'either specify a bookie, or tick "no specific book"' });

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) return respond({ ok: false, error: 'Sheet "' + SHEET_NAME + '" not found' });

    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const autofillFlags = sheet.getRange(AUTOFILL_ROW, 1, 1, lastCol).getValues()[0];

    let targetCols; // array of { col, bookieName }
    if (bookie) {
      // A specific bookie was named — this always wins, regardless of its autofill tickbox state.
      const col = headers.findIndex(h => h.toLowerCase() === bookie.toLowerCase()) + 1;
      if (col < 1) return respond({ ok: false, error: 'Bookie column "' + bookie + '" not found on the Accounts sheet' });
      targetCols = [{ col: col, bookieName: headers[col-1] }];
    } else {
      // "No specific book" — every bookie column whose tickbox is TRUE.
      targetCols = [];
      for (let c = 2; c <= lastCol; c++) { // column A is the profile column, bookies start at B
        if (autofillFlags[c-1] === true && headers[c-1]) targetCols.push({ col: c, bookieName: headers[c-1] });
      }
      if (!targetCols.length) return respond({ ok: false, error: 'No bookie columns are ticked for autofill' });
    }

    const lastRow = sheet.getLastRow();
    const profileCol = 1;
    const results = [];

    targetCols.forEach(({ col, bookieName }) => {
      let searchRow = FIRST_DATA_ROW;
      names.forEach(name => {
        let filled = false;
        while (searchRow <= lastRow) {
          const profileVal = sheet.getRange(searchRow, profileCol).getValue();
          const bookieVal = sheet.getRange(searchRow, col).getValue();
          if (profileVal && (!bookieVal || String(bookieVal).trim() === '')) {
            sheet.getRange(searchRow, col).setValue(name).setBackground(COLOR_UNTESTED);
            results.push({ ok: true, name: name, bookie: bookieName, profile: String(profileVal).trim(), row: searchRow });
            filled = true;
            searchRow++;
            break;
          }
          searchRow++;
        }
        if (!filled) {
          results.push({ ok: false, name: name, bookie: bookieName, error: 'No blank ' + bookieName + ' slots left' });
        }
      });
    });

    return respond({ ok: true, results: results });
  } catch (err) {
    return respond({ ok: false, error: err.toString() });
  }
}

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
