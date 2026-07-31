const { GoogleAuthService } = require('./dist/modules/google/auth/auth.service');
const { google } = require('googleapis');

async function main() {
  const email = 'rec@meet.finquojunior.com';
  const folderId = '1JcjQMhkWCiwQAiFWGe5kGQR3EqKFk5dw';
  console.log('Listing files in folder:', folderId, 'for account:', email);
  try {
    const auth = await GoogleAuthService.getClientForEmail(email);
    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, size, createdTime)',
      orderBy: 'createdTime desc'
    });

    console.log('FOLDER FILES:');
    console.log(JSON.stringify(response.data.files, null, 2));
  } catch (err) {
    console.error('Error listing folder files:', err.message);
  }
}

main();
