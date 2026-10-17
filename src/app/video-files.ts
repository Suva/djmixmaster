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
