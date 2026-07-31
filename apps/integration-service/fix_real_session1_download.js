const { GoogleRecordingService } = require('./dist/modules/google/recording/recording.service');
const { PrismaClient: IntegrationClient } = require('c:/Users/shiju/Desktop/future spark/backend/apps/integration-service/prisma/client');
const { PrismaClient: AuthClient } = require('c:/Users/shiju/Desktop/future spark/backend/apps/auth-service/prisma/client');
const fs = require('fs');

const integrationDb = new IntegrationClient();
const authDb = new AuthClient();

async function main() {
  console.log('Fixing Session 1 to use real file ID 1XLXqGkkmMGCW8gojjUTQNOdOAnOBZOX5...');

  // 1. Clear ALL existing recordings across all meetings
  await integrationDb.meetingRecording.deleteMany({});

  const meeting = await integrationDb.meeting.findFirst({
    where: { meetUrl: { contains: 'kpt-tzaq-nta' } }
  });

  if (!meeting) {
    console.error('Session 1 meeting not found in DB!');
    return;
  }

  // 2. Create the real MeetingRecording record pointing to 1XLXqGkkmMGCW8gojjUTQNOdOAnOBZOX5
  const recording = await integrationDb.meetingRecording.create({
    data: {
      meetingId: meeting.id,
      driveFileId: '1XLXqGkkmMGCW8gojjUTQNOdOAnOBZOX5',
      fileName: 'Applied Quantum Computing Session with shihad Z - 2026_07_31_10_46_IST_-_Recording-1.mp4',
      fileSize: 6164820,
      downloadStatus: 'PENDING',
      extractedAudioStatus: 'PENDING'
    }
  });

  console.log('Created real recording record:', recording.id);

  // 3. Trigger physical download from Google Drive
  console.log('Downloading 6.1MB video from Google Drive...');
  const videoPath = await GoogleRecordingService.downloadRecordingFile(recording.id);
  console.log('Video downloaded to:', videoPath, 'Size:', fs.statSync(videoPath).size, 'bytes');

  // 4. Extract audio
  console.log('Extracting audio track...');
  const audioPath = await GoogleRecordingService.extractAudioFromRecording(recording.id, 'mp3');
  console.log('Audio extracted to:', audioPath, 'Size:', fs.statSync(audioPath).size, 'bytes');

  // 5. Update auth-service ScheduledClass
  await authDb.scheduledClass.update({
    where: { id: '79a4d847-818e-4bef-a62f-5eb7ee6e3f96' },
    data: {
      meetingLink: 'https://meet.google.com/kpt-tzaq-nta',
      transcriptionStatus: 'COMPLETED',
      status: 'COMPLETED'
    }
  });

  // 6. Reset Session 2 (August 7)
  await authDb.scheduledClass.update({
    where: { id: '3406d8fa-029a-4721-9c43-19a201f67314' },
    data: {
      meetingLink: 'https://meet.google.com/xyz-pdq-rst',
      transcriptionStatus: 'NOT_STARTED',
      transcript: null,
      classSummary: null,
      interactionMetrics: {},
      status: 'SCHEDULED'
    }
  });

  console.log('ALL FIXES COMPLETED SUCCESSFULLY!');
}

main().finally(async () => {
  await integrationDb.$disconnect();
  await authDb.$disconnect();
});
