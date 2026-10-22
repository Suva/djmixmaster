/*
 * djm-capture: records two channels of an audio input for DJ Mix Master.
 *
 * Neither ffmpeg's capture (which on macOS drops sound whenever it is read
 * late) nor Chromium's (two channels at most) does for a sound card with more
 * inputs, so the app starts this instead. It uses miniaudio, which talks to
 * Core Audio, WASAPI, ALSA, PulseAudio and JACK alike.
 *
 *   djm-capture list [--test]
 *     Prints the inputs as JSON: [{"id", "name", "channels", "rates", "default"}].
 *     With --test, the test interface too: four channels of tones, generated,
 *     at 48 kHz, its id "test", for checks on a machine with no sound card.
 *
 *   djm-capture record --device <id> --channels <a>,<b> [--rate <hz>]
 *     Writes channels a and b (counted from 1; the same twice puts one on
 *     both sides) to stdout as interleaved 32-bit float samples, for the
 *     ffmpeg that writes the recording; nothing goes to stdout when it is
 *     not wanted, as while monitoring. On stderr, one JSON line per event:
 *       {"started": {"rate", "channels", "device"}}   once open
 *       {"levels": {"peak": [l, r], "meanSquare": [l, r], "frames": n}}   ten times a second
 *       {"lost": n}   frames that could not be kept, should the writing ever fall 10 s behind
 *       {"error": "..."}   and then it ends
 *     A "q" on stdin stops it, once what it holds has been written. A stdin
 *     that closes does not: should the app go down, the recording goes on, and
 *     ends when ffmpeg, reading stdout, does.
 *
 * The device's callback only copies into a ring buffer; the main thread
 * writes from it. Nothing is dropped silently.
 */

/* POSIX, which a strict C11 hides on Linux's C library: nanosleep, clock_gettime and the rest. Before any include. */
#if !defined(_WIN32) && !defined(__APPLE__)
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#endif

#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_NODE_GRAPH
#define MA_NO_ENGINE
/* Its stand-in that hears nothing, used where no sound system answers, is no input to offer. */
#define MA_NO_NULL
#include "miniaudio/miniaudio.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
static void pause_ms(int ms) { Sleep(ms); }
static double seconds_now(void) {
  LARGE_INTEGER now, rate;
  QueryPerformanceCounter(&now);
  QueryPerformanceFrequency(&rate);
  return (double)now.QuadPart / (double)rate.QuadPart;
}
#else
#include <pthread.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
static void pause_ms(int ms) {
  struct timespec t = { ms / 1000, (long)(ms % 1000) * 1000000L };
  nanosleep(&t, NULL);
}
static double seconds_now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}
#endif

/* The test interface: each channel a tone at a level of its own, the first at half of full scale and each next one half as loud. */
#define TEST_ID "test"
#define TEST_RATE 48000
#define TEST_CHANNELS 4
static const double TEST_HZ[TEST_CHANNELS] = { 440, 550, 660, 880 };

/* How much the ring buffer holds, in seconds: how far the writing may fall behind before sound is lost. */
#define RING_SECONDS 10
/* Levels are sent this often, in frames per second divided by this. */
#define LEVELS_PER_SECOND 10

static ma_pcm_rb ring;
static ma_uint32 pick[2];
static ma_uint32 device_channels;
static volatile ma_uint64 lost;
static volatile int stop_asked;

/* ------------------------------------------------------------------ */
/* Text out */

/* A string as JSON, written to `out`. */
static void json_string(FILE *out, const char *text) {
  fputc('"', out);
  for (const unsigned char *c = (const unsigned char *)text; *c; c++) {
    if (*c == '"' || *c == '\\') fprintf(out, "\\%c", *c);
    else if (*c < 0x20) fprintf(out, "\\u%04x", *c);
    else fputc(*c, out);
  }
  fputc('"', out);
}

static void say_error(const char *message) {
  fputs("{\"error\": ", stderr);
  json_string(stderr, message);
  fputs("}\n", stderr);
  fflush(stderr);
}

/* A device's id, the bytes of miniaudio's for it as hex, without the zeros that end it: the same on every system. */
static void id_text(const ma_device_id *id, char *out) {
  const unsigned char *bytes = (const unsigned char *)id;
  size_t length = sizeof(*id);
  while (length > 0 && bytes[length - 1] == 0) length--;
  for (size_t i = 0; i < length; i++) sprintf(out + i * 2, "%02x", bytes[i]);
  out[length * 2] = 0;
}

static int id_from_text(const char *text, ma_device_id *id) {
  size_t length = strlen(text);
  if (length % 2 || length / 2 > sizeof(*id)) return 0;
  memset(id, 0, sizeof(*id));
  unsigned char *bytes = (unsigned char *)id;
  for (size_t i = 0; i < length / 2; i++) {
    unsigned int value;
    if (sscanf(text + i * 2, "%2x", &value) != 1) return 0;
    bytes[i] = (unsigned char)value;
  }
  return 1;
}

/* ------------------------------------------------------------------ */
/* list */

static int list(ma_context *context, int with_test) {
  ma_device_info *captures = NULL;
  ma_uint32 count = 0;
  if (context && ma_context_get_devices(context, NULL, NULL, &captures, &count) != MA_SUCCESS) {
    say_error("The inputs could not be listed.");
    return 1;
  }
  char id[sizeof(ma_device_id) * 2 + 1];
  fputc('[', stdout);
  if (with_test) printf("{\"id\": \"%s\", \"name\": \"Test interface\", \"channels\": %d, \"rates\": [%d], \"default\": false}%s", TEST_ID, TEST_CHANNELS, TEST_RATE, count ? ", " : "");
  for (ma_uint32 i = 0; i < count; i++) {
    ma_device_info info;
    /* The full information has the formats the device takes; the list alone does not. */
    if (ma_context_get_device_info(context, ma_device_type_capture, &captures[i].id, &info) != MA_SUCCESS) info = captures[i];
    ma_uint32 channels = 0;
    ma_uint32 rates[16];
    ma_uint32 rate_count = 0;
    for (ma_uint32 f = 0; f < info.nativeDataFormatCount; f++) {
      if (info.nativeDataFormats[f].channels > channels) channels = info.nativeDataFormats[f].channels;
      ma_uint32 rate = info.nativeDataFormats[f].sampleRate;
      int known = 0;
      for (ma_uint32 r = 0; r < rate_count; r++) known |= rates[r] == rate;
      if (!known && rate != 0 && rate_count < 16) rates[rate_count++] = rate;
    }
    id_text(&captures[i].id, id);
    printf("%s{\"id\": \"%s\", \"name\": ", i ? ", " : "", id);
    json_string(stdout, info.name);
    printf(", \"channels\": %u, \"rates\": [", channels);
    for (ma_uint32 r = 0; r < rate_count; r++) printf("%s%u", r ? ", " : "", rates[r]);
    printf("], \"default\": %s}", captures[i].isDefault ? "true" : "false");
  }
  fputs("]\n", stdout);
  return 0;
}

/* ------------------------------------------------------------------ */
/* record */

/* In the device's own thread: the two channels wanted, into the ring. Never waits. */
static void on_sound(ma_device *device, void *output, const void *input, ma_uint32 frames) {
  (void)device;
  (void)output;
  const float *in = (const float *)input;
  ma_uint32 done = 0;
  while (done < frames) {
    ma_uint32 room = frames - done;
    void *place;
    if (ma_pcm_rb_acquire_write(&ring, &room, &place) != MA_SUCCESS || room == 0) break;
    float *out = (float *)place;
    for (ma_uint32 f = 0; f < room; f++) {
      out[f * 2] = in[(done + f) * device_channels + pick[0]];
      out[f * 2 + 1] = in[(done + f) * device_channels + pick[1]];
    }
    ma_pcm_rb_commit_write(&ring, room);
    done += room;
  }
  if (done < frames) lost += frames - done;
}

/* The test interface's own thread: tones, a hundredth of a second at a time, as fast as a clock says a device would give them. */
static volatile int generating;
#ifdef _WIN32
static DWORD WINAPI generate(LPVOID unused) {
#else
static void *generate(void *unused) {
#endif
  (void)unused;
  float block[TEST_RATE / 100 * TEST_CHANNELS];
  const double start = seconds_now();
  ma_uint64 made = 0;
  while (generating) {
    ma_uint64 due = (ma_uint64)((seconds_now() - start) * TEST_RATE);
    while (made + TEST_RATE / 100 <= due) {
      for (int f = 0; f < TEST_RATE / 100; f++) {
        for (int c = 0; c < TEST_CHANNELS; c++) {
          double level = 0.5 / (double)(1 << c);
          block[f * TEST_CHANNELS + c] = (float)(level * sin(2 * MA_PI_D * TEST_HZ[c] * (double)(made + f) / TEST_RATE));
        }
      }
      on_sound(NULL, NULL, block, TEST_RATE / 100);
      made += TEST_RATE / 100;
    }
    pause_ms(2);
  }
  return 0;
}

/* Waits for a "q" on stdin. A stdin that closes is not one. */
#ifdef _WIN32
static DWORD WINAPI watch_stdin(LPVOID unused) {
#else
static void *watch_stdin(void *unused) {
#endif
  (void)unused;
  int c;
  while ((c = getchar()) != EOF) {
    if (c == 'q') {
      stop_asked = 1;
      break;
    }
  }
  return 0;
}

static int record(ma_context *context, const char *device_text, ma_uint32 a, ma_uint32 b, ma_uint32 rate, int to_stdout) {
  const int test = strcmp(device_text, TEST_ID) == 0;
  ma_device_id id;
  if (test) memset(&id, 0, sizeof(id));
  else if (!id_from_text(device_text, &id)) {
    say_error("That is not a device's id.");
    return 1;
  }
  ma_device_info info;
  ma_uint32 channels = 0;
  if (test) {
    strcpy(info.name, "Test interface");
    channels = TEST_CHANNELS;
  } else {
    if (ma_context_get_device_info(context, ma_device_type_capture, &id, &info) != MA_SUCCESS) {
      say_error("The input is not connected.");
      return 1;
    }
    for (ma_uint32 f = 0; f < info.nativeDataFormatCount; f++) {
      if (info.nativeDataFormats[f].channels > channels) channels = info.nativeDataFormats[f].channels;
    }
    if (channels == 0) channels = 2;
  }
  if (a < 1 || b < 1 || a > channels || b > channels) {
    say_error("The input does not have those channels.");
    return 1;
  }
  pick[0] = a - 1;
  pick[1] = b - 1;

  ma_device device;
  ma_uint32 actual_rate;
  if (test) {
    device_channels = TEST_CHANNELS;
    actual_rate = TEST_RATE;
  } else {
    ma_device_config config = ma_device_config_init(ma_device_type_capture);
    config.capture.pDeviceID = &id;
    config.capture.format = ma_format_f32;
    /* All of the device's channels, as it gives them; the two wanted are picked out of them. */
    config.capture.channels = channels;
    config.capture.shareMode = ma_share_mode_shared;
    /* Its own rate unless another is asked for, so that nothing is resampled. */
    config.sampleRate = rate;
    config.dataCallback = on_sound;
    /* Nothing done to the sound: no mixing down, no change of rate behind our back. */
    config.noPreSilencedOutputBuffer = MA_TRUE;
    config.noClip = MA_TRUE;
    if (ma_device_init(context, &config, &device) != MA_SUCCESS) {
      say_error("The input could not be opened.");
      return 1;
    }
    device_channels = device.capture.channels;
    actual_rate = device.sampleRate;
  }
  if (ma_pcm_rb_init(ma_format_f32, 2, actual_rate * RING_SECONDS, NULL, NULL, &ring) != MA_SUCCESS) {
    say_error("There was no memory for the sound.");
    if (!test) ma_device_uninit(&device);
    return 1;
  }

#ifdef _WIN32
  CreateThread(NULL, 0, watch_stdin, NULL, 0, NULL);
#else
  pthread_t watcher;
  pthread_create(&watcher, NULL, watch_stdin, NULL);
  pthread_detach(watcher);
#endif

  if (test) {
    generating = 1;
#ifdef _WIN32
    CreateThread(NULL, 0, generate, NULL, 0, NULL);
#else
    pthread_t generator;
    pthread_create(&generator, NULL, generate, NULL);
    pthread_detach(generator);
#endif
  } else if (ma_device_start(&device) != MA_SUCCESS) {
    say_error("The input could not be started.");
    ma_device_uninit(&device);
    return 1;
  }
  fprintf(stderr, "{\"started\": {\"rate\": %u, \"channels\": %u, \"device\": ", actual_rate, device_channels);
  json_string(stderr, info.name);
  fputs("}}\n", stderr);
  fflush(stderr);

  const ma_uint32 level_frames = actual_rate / LEVELS_PER_SECOND;
  float peak[2] = { 0, 0 };
  double sum[2] = { 0, 0 };
  ma_uint32 measured = 0;
  ma_uint64 told_lost = 0;
  int failed = 0;
  for (;;) {
    int stopping = stop_asked;
    ma_uint32 frames = ma_pcm_rb_available_read(&ring);
    if (frames == 0) {
      if (stopping) break;
      if (!test && ma_device_get_state(&device) != ma_device_state_started) {
        say_error("The input went away.");
        failed = 1;
        break;
      }
      pause_ms(5);
      continue;
    }
    void *place;
    if (ma_pcm_rb_acquire_read(&ring, &frames, &place) != MA_SUCCESS) break;
    const float *samples = (const float *)place;
    if (to_stdout && fwrite(samples, sizeof(float) * 2, frames, stdout) != frames) {
      /* Nobody is reading: ffmpeg has ended, and so has the recording. */
      ma_pcm_rb_commit_read(&ring, frames);
      failed = 1;
      break;
    }
    for (ma_uint32 f = 0; f < frames; f++) {
      for (int c = 0; c < 2; c++) {
        float value = samples[f * 2 + c];
        float magnitude = fabsf(value);
        if (magnitude > peak[c]) peak[c] = magnitude;
        sum[c] += (double)value * value;
      }
      if (++measured == level_frames) {
        fprintf(stderr, "{\"levels\": {\"peak\": [%.6f, %.6f], \"meanSquare\": [%.8f, %.8f], \"frames\": %u}}\n",
          peak[0], peak[1], sum[0] / measured, sum[1] / measured, measured);
        fflush(stderr);
        peak[0] = peak[1] = 0;
        sum[0] = sum[1] = 0;
        measured = 0;
      }
    }
    ma_pcm_rb_commit_read(&ring, frames);
    if (lost != told_lost) {
      told_lost = lost;
      fprintf(stderr, "{\"lost\": %llu}\n", (unsigned long long)told_lost);
      fflush(stderr);
    }
  }
  if (to_stdout) fflush(stdout);
  if (test) generating = 0;
  else ma_device_uninit(&device);
  ma_pcm_rb_uninit(&ring);
  return failed;
}

int main(int argc, char **argv) {
#ifdef _WIN32
  _setmode(_fileno(stdout), _O_BINARY);
#else
  /* A reader gone is seen as a failed write, not as the end of the program. */
  signal(SIGPIPE, SIG_IGN);
#endif
  if (argc < 2 || (strcmp(argv[1], "list") != 0 && strcmp(argv[1], "record") != 0)) {
    fputs("Usage: djm-capture list [--test]\n       djm-capture record --device <id> --channels <a>,<b> [--rate <hz>] [--no-output]\n", stderr);
    return 2;
  }
  const char *device = NULL;
  ma_uint32 a = 1, b = 2, rate = 0;
  int to_stdout = 1;
  int with_test = 0;
  for (int i = 2; i < argc; i++) {
    if (strcmp(argv[i], "--device") == 0 && i + 1 < argc) device = argv[++i];
    else if (strcmp(argv[i], "--channels") == 0 && i + 1 < argc) {
      if (sscanf(argv[++i], "%u,%u", &a, &b) != 2) a = b = 0;
    } else if (strcmp(argv[i], "--rate") == 0 && i + 1 < argc) rate = (ma_uint32)strtoul(argv[++i], NULL, 10);
    else if (strcmp(argv[i], "--no-output") == 0) to_stdout = 0;
    else if (strcmp(argv[i], "--test") == 0) with_test = 1;
    else {
      say_error("An option was not understood.");
      return 2;
    }
  }

  ma_context context;
  if (ma_context_init(NULL, 0, NULL, &context) != MA_SUCCESS) {
    say_error("The system's sound could not be reached.");
    return 1;
  }
  int result;
  if (strcmp(argv[1], "list") == 0) result = list(&context, with_test);
  else if (!device) {
    say_error("No device was named.");
    result = 2;
  } else result = record(&context, device, a, b, rate, to_stdout);
  ma_context_uninit(&context);
  return result;
}
