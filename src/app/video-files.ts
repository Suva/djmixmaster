// Recordings that are videos: which files are taken as such, and how their
// own picture is exported. Shared by the main process and the window.

/** Videos open as recordings too: their sound is mastered, and their picture can go with it. */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm'];

/** Picture codecs an MP4 can hold as they are; anything else (ProRes, DNxHD) goes into a MOV. */
const MP4_PICTURES = ['h264', 'hevc', 'av1', 'mpeg4', 'vp9'];

/**
 * The container for a video export that keeps the recording's own picture:
 * MP4 where the picture fits one, MOV otherwise.
 */
export const originalPictureExtension = (codec: string) => (MP4_PICTURES.includes(codec) ? 'mp4' : 'mov');

/**
 * Picture codecs a video export tries to decode with the browser's own video
 * decoder, on the graphics card where it can; others are decoded by ffmpeg.
 */
export const DECODER_CODECS = ['h264', 'hevc', 'vp9', 'av1'];

/**
 * The arguments for ffmpeg that copy a video file's picture, not decoded,
 * from the keyframe at or before `from` seconds into it: as a fragmented MP4
 * with a fragment for each frame, so that each comes out as soon as it is
 * read, and each frame at its own time in the file (counted from the file's
 * start, which `-start_at_zero` makes 0), moved on by `offset` seconds.
 * `frag_discont` with `delay_moov` keeps those times: without them, ffmpeg
 * starts the MP4's times at 0 wherever it starts.
 */
export const clipStreamArgs = (file: string, from: number, offset = 0) => [
  '-v', 'error', '-nostdin', '-ss', String(from), '-copyts', '-start_at_zero', '-i', file,
  '-map', '0:v:0', '-an', '-c:v', 'copy', '-output_ts_offset', String(offset),
  '-f', 'mp4', '-movflags', 'delay_moov+default_base_moof+frag_every_frame+frag_discont', '-',
];
