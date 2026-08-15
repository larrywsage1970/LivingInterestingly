/**
 * Google Apps Script "Drive bridge" for the Transcript Extractor.
 *
 * Deploy this as a Web App (Execute as: Me, Access: Anyone) at
 * script.google.com. It runs under YOUR Google identity, so it can write to
 * your Drive with no OAuth client, consent screen, or verification step -
 * the Cloudflare Worker POSTs transcript text here and this drops it into a
 * Drive folder as a plain .txt file (not a Google Doc), so it's already in
 * the format most note-taking/blog/podcast tools expect to import, no
 * File > Download conversion step needed first.
 *
 * The Worker calls this automatically right after a transcript finishes
 * (YouTube or podcast), not on a separate button press - by the time you
 * see the transcript on your phone, it's already in Drive.
 *
 * Guarded by SHARED_SECRET since "Anyone with the link" can technically call
 * this URL - set it below, and set the matching value as the Worker's
 * APPS_SCRIPT_TOKEN secret. Treat both the deployment URL and this secret
 * like credentials - don't post them publicly.
 */

const SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING';
const FOLDER_NAME = 'Transcripts';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== SHARED_SECRET) {
      return jsonResponse({ error: 'Unauthorized' });
    }
    if (!body.text || !body.filename) {
      return jsonResponse({ error: 'Missing filename or text' });
    }
    const folder = getOrCreateFolder(FOLDER_NAME);

    const safeName = body.filename.endsWith('.txt') ? body.filename : body.filename + '.txt';
    const file = folder.createFile(safeName, body.text, MimeType.PLAIN_TEXT);

    return jsonResponse({ fileId: file.getId(), link: file.getUrl() });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
