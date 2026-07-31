const { GoogleAuthService } = require('./dist/modules/google/auth/auth.service');
const { google } = require('googleapis');

async function main() {
  const email = 'rec@meet.finquojunior.com';
  const folderId = '1JcjQMhkWCiwQAiFWGe5kGQR3EqKFk5dw';
  console.log('Querying parents directly for:', folderId);
  try {
    const auth = await GoogleAuthService.getClientForEmail(email);
    const drive = google.drive({ version: 'v3', auth });

    const q = `'${folderId}' in parents and mimeType = 'video/mp4' and trashed = false`;
    const response = await drive.files.list({
      q,
      fields: 'files(id, name, size, mimeType, createdTime, webContentLink)',
      orderBy: 'createdTime desc',
      pageSize: 10
    });

    console.log('RESULTS:');
    console.log(JSON.stringify(response.data.files, null, 2));
  } catch (err) {
    console.error('Error:', err.message);
  }
}

main();
