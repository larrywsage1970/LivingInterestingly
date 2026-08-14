/**
 * Google Apps Script "Drive bridge" for the YouTube Transcript Extractor.
 *
 * Deploy this as a Web App (Execute as: Me, Access: Anyone) at
 * script.google.com. It runs under YOUR Google identity, so it can write to
 * your Drive with no OAuth client, consent screen, or verification step -
 * the Cloudflare Worker just POSTs transcript text here and this creates a
 * Google Doc from it in a Drive folder. Google Docs' own File > Download
 * covers exporting to PDF/Word/plain text/etc. from there.
 *
 * Guarded by SHARED_SECRET since "Anyone with the link" can technically call
 * this URL - set it below, and set the matching value as the Worker's
 * APPS_SCRIPT_TOKEN secret. Treat both the deployment URL and this secret
 * like credentials - don't post them publicly.
 */

const SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING';
const FOLDER_NAME = 'YouTube Transcripts';

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

    // Create as a real Google Doc (not a plain .txt file) so it opens
    // straight into Docs, and File > Download there covers PDF/Word/etc.
    // for whatever tool the transcript ends up feeding.
    const doc = DocumentApp.create(body.filename);
    doc.getBody().setText(body.text);
    doc.saveAndClose();

    const docFile = DriveApp.getFileById(doc.getId());
    folder.addFile(docFile);
    DriveApp.getRootFolder().removeFile(docFile); // Docs are created at Drive root by default; this re-parents into FOLDER_NAME

    return jsonResponse({ fileId: doc.getId(), link: docFile.getUrl() });
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
