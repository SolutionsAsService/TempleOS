/* launcher.c -- the Windows launcher of a gamec Steam build (gamec dist --steam).  Built with mingw-w64:
 *   x86_64-w64-mingw32-gcc -O2 -mwindows -DGAME_NAME=\"HolyTemple\" -DGAME_TITLE=\"The Holy Temple\" launcher.c -o HolyTemple.exe
 *
 * Layout beside the exe (the Steam depot, read only as far as we are concerned):
 *   <NAME>.img         TempleOS installed + the game; booted with snapshot=on, so it is never written and an update can replace it
 *   saves-empty.img    an empty FAT32 disk: copied once to the player's folder as saves.img
 *   qemu\qemu-system-x86_64.exe   QEMU for Windows (GPL-2.0, unmodified; its licence and source beside it)
 * The player's folder: %APPDATA%\<NAME>\saves.img.  TempleOS mounts it as E: (MountIDEAuto in the image's Once.HC) and the game
 * keeps Save.DAT and Memory.DAT there.  Steam updates and "verify files" never touch it.
 * Settings by environment: HT_ACCEL (default "-accel tcg"; e.g. "-accel whpx -accel tcg"), HT_QEMU_ARGS (appended),
 * HT_AUDIO=none.  A log of the last start: %APPDATA%\<NAME>\launcher.log.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef GAME_NAME
#define GAME_NAME "HolyTemple"
#endif
#ifndef GAME_TITLE
#define GAME_TITLE "The Holy Temple"
#endif

static char dir[MAX_PATH], data[MAX_PATH], logpath[MAX_PATH];

static void logf_(const char *fmt, const char *a) {
  FILE *f = fopen(logpath, "a");
  if (f) { fprintf(f, fmt, a); fputc('\n', f); fclose(f); }
}

static void fail(const char *msg, const char *detail) {
  char buf[2048];
  snprintf(buf, sizeof buf, "%s\n\n%s\n\nLog: %s", msg, detail ? detail : "", logpath);
  logf_("FAIL: %s", buf);
  MessageBoxA(NULL, buf, GAME_TITLE, MB_OK | MB_ICONERROR);
  exit(1);
}

static int exists(const char *p) { return GetFileAttributesA(p) != INVALID_FILE_ATTRIBUTES; }

/* QEMU's -drive splits on commas; a comma inside a path is written twice */
static const char *qpath(const char *p) {
  static char bufs[2][MAX_PATH * 2]; static int n;
  char *o = bufs[n++ & 1], *q = o;
  for (; *p && q < o + sizeof bufs[0] - 2; p++) { *q++ = *p; if (*p == ',') *q++ = ','; }
  *q = 0; return o;
}

int WINAPI WinMain(HINSTANCE h, HINSTANCE p, LPSTR cmd, int show) {
  char path[MAX_PATH], qemu[MAX_PATH], img[MAX_PATH], saves[MAX_PATH], empty[MAX_PATH], line[8192], env[1024];
  const char *accel = "-accel tcg", *extra = "", *audio = "-audiodev dsound,id=snd0 -machine pc,pcspk-audiodev=snd0";
  (void)h; (void)p; (void)show;

  GetModuleFileNameA(NULL, dir, MAX_PATH);
  *strrchr(dir, '\\') = 0;
  if (SHGetFolderPathA(NULL, CSIDL_APPDATA | CSIDL_FLAG_CREATE, NULL, 0, path) != S_OK) fail("Cannot find your AppData folder.", NULL);
  snprintf(data, sizeof data, "%s\\%s", path, GAME_NAME);
  CreateDirectoryA(data, NULL);
  snprintf(logpath, sizeof logpath, "%s\\launcher.log", data);
  DeleteFileA(logpath);
  logf_("game folder: %s", dir);

  snprintf(img, sizeof img, "%s\\%s.img", dir, GAME_NAME);
  snprintf(empty, sizeof empty, "%s\\saves-empty.img", dir);
  snprintf(saves, sizeof saves, "%s\\saves.img", data);
  if (!exists(img)) fail("The game disk is missing. In Steam: Properties > Installed Files > Verify integrity.", img);
  if (!exists(saves)) {
    if (!CopyFileA(empty, saves, TRUE)) fail("Could not make your save disk.", saves);
    logf_("made %s", saves);
  }

  if (GetEnvironmentVariableA("HT_QEMU", qemu, sizeof qemu) == 0)
    snprintf(qemu, sizeof qemu, "%s\\qemu\\qemu-system-x86_64w.exe", dir);   /* the "w" build opens no console */
  if (!exists(qemu)) snprintf(qemu, sizeof qemu, "%s\\qemu\\qemu-system-x86_64.exe", dir);
  if (!exists(qemu)) fail("QEMU is missing from the game folder.", qemu);
  if (GetEnvironmentVariableA("HT_ACCEL", env, sizeof env)) accel = _strdup(env);
  if (GetEnvironmentVariableA("HT_QEMU_ARGS", env, sizeof env)) extra = _strdup(env);
  if (GetEnvironmentVariableA("HT_AUDIO", env, sizeof env) && !_stricmp(env, "none")) audio = "";

  snprintf(line, sizeof line,
    "\"%s\" -name \"%s\" -m 1024 -smp 2 %s -vga std -display gtk,zoom-to-fit=on -rtc base=localtime %s "
    "-nic none -drive \"file=%s,format=raw,if=ide,index=0,media=disk,snapshot=on\" "
    "-drive \"file=%s,format=raw,if=ide,index=1,media=disk\" -drive if=ide,index=2,media=cdrom -boot c %s %s",
    qemu, GAME_TITLE, accel, audio, qpath(img), qpath(saves), extra, cmd ? cmd : "");
  logf_("start: %s", line);

  STARTUPINFOA si; PROCESS_INFORMATION pi;
  memset(&si, 0, sizeof si); si.cb = sizeof si;
  if (!CreateProcessA(NULL, line, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, dir, &si, &pi)) {
    char e[64]; snprintf(e, sizeof e, "Windows error %lu", GetLastError());
    fail("QEMU did not start.", e);
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0; GetExitCodeProcess(pi.hProcess, &code);
  { char c[32]; snprintf(c, sizeof c, "%lu", code); logf_("QEMU exited with %s", c); }
  return (int)code;
}
