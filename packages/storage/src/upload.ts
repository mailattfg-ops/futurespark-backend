import * as path from "path";

export interface UploadOptions {
  contentType?: string;
  prefix?: string;
}

export function getS3KeyForRecording(recordingId: string, originalFileName: string, type: "video" | "audio" | "transcript"): string {
  const safeBase = originalFileName.replace(/[^a-zA-Z0-9_\-.]/g, "_");
  const ext = originalFileName.endsWith(".mp4") ? ".mp4" : originalFileName.endsWith(".mp3") ? ".mp3" : path.extname(originalFileName);
  const baseName = safeBase.substring(0, safeBase.lastIndexOf(".")) || safeBase;
  
  if (type === "video") {
    return `recordings/video/${recordingId}_${baseName}.mp4`;
  }
  if (type === "audio") {
    return `recordings/audio/${recordingId}_${baseName}.mp3`;
  }
  return `recordings/video/${recordingId}_${baseName}.mp4.transcript.txt`;
}

export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}
