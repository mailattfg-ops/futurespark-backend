const { GoogleAuthService } = require('./dist/modules/google/auth/auth.service');
const { google } = require('googleapis');

async function main() {
  const email = 'rec@meet.finquojunior.com';
  const fileId = '1XLXqGkkmMGCW8gojjUTQNOdOAnOBZOX5';
  console.log('Testing Google Drive download for real fileId:', fileId);

  try {
    const auth = await GoogleAuthService.getClientForEmail(email);
    const drive = google.drive({ version: 'v3', auth });

    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    console.log('Download SUCCESS! Headers:', res.headers);
  } catch (err) {
    console.error('Download FAILED with error:', err.message);
  }
}

main();
