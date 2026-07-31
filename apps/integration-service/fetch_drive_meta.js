const { GoogleAuthService } = require('./dist/modules/google/auth/auth.service');
const { google } = require('googleapis');

async function main() {
  const email = 'rec@meet.finquojunior.com';
  console.log('Fetching file metadata for account:', email);
  try {
    const auth = await GoogleAuthService.getClientForEmail(email);
    const drive = google.drive({ version: 'v3', auth });

    const response = await drive.files.list({
      q: "mimeType = 'video/mp4' and trashed = false",
      fields: 'files(id, name, description, properties, appProperties, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 5
    });

    console.log('FILES:');
    console.log(JSON.stringify(response.data.files, null, 2));
  } catch (err) {
    console.error('Error fetching file list:', err.message);
  }
}

main();
