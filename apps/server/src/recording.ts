import { MAX_RECORDING_BYTES, type AudioMime } from '../../../packages/shared/protocol';
import { HttpError } from './errors';

/** Validate size, canonical base64 and container signatures, never filenames supplied by a client. */
export function validateRecording(encoded: string, mimeType: AudioMime): Buffer {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 32 || bytes.length > MAX_RECORDING_BYTES || bytes.toString('base64') !== encoded) throw new HttpError(400, 'invalid_recording', '录音为空、损坏或超过 4 MB，请重新录音。');
  const webm = mimeType === 'audio/webm' && bytes.subarray(0, 4).toString('hex') === '1a45dfa3' && bytes.subarray(0, 4096).includes(Buffer.from('webm'));
  const ogg = mimeType === 'audio/ogg' && bytes.subarray(0, 4).toString('ascii') === 'OggS' && bytes[4] === 0;
  const mp4 = mimeType === 'audio/mp4' && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && bytes.readUInt32BE(0) >= 12 && bytes.readUInt32BE(0) <= bytes.length;
  if (!webm && !ogg && !mp4) throw new HttpError(400, 'invalid_recording', '录音的实际格式与声明不符，请使用 Edge 或 Chrome 重新录音。');
  return bytes;
}
