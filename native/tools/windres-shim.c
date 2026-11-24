/* windres-shim：资源编译直通 shim（解决中文项目路径下 windres 打不开 ICON 的问题）。
 *
 * 背景：tauri-build → tauri-winres → embed-resource 生成 resource.rc（OUT_DIR 内，ASCII），
 * 但 rc 里的 ICON/manifest 路径烙有 CARGO_MANIFEST_DIR 的真实路径；项目路径含中文时
 * windres（窄字符 API + UTF-8/ANSI 编码错配）报 Invalid argument / No such file or directory。
 * 现代 binutils windres 不再默认走外部 gcc 预处理，gcc shim 挂不上，故直接 shim windres。
 *
 * 做法：run.ps1 创建 ASCII junction（ML_ASCII_ROOT）指向项目真实根（ML_REAL_ROOT）并导出；
 * 本 shim 安装为 .tools\bin\x86_64-w64-mingw32-windres.exe（PATH 里排在真 windres 前，
 * embed-resource 对 windows-gnu 目标默认按此名查找）。它把 --input 指定的 rc 内容做
 * UTF-8 字节级替换（真实根 → junction 根，兼容 rc 的 \\ 双反斜杠转义形式）后写临时文件，
 * 用临时文件转调 ../binutils/mingw64/bin/windres.exe，结束删除临时文件。
 * 未设置环境变量时纯透传，行为与真 windres 完全一致。
 *
 * 编译（须在 ASCII 工作目录，见 native/toolchain.ps1）：
 *   gcc -O2 -o windres-shim.exe windres-shim.c -municode
 * 安装为 .tools\bin\x86_64-w64-mingw32-windres.exe 与 .tools\bin\windres.exe
 */
#include <windows.h>
#include <wchar.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define MAXW 1024

static int rewriteU8(const char *src, size_t srcLen, const char *needle, const char *repl, char **outPtr, size_t *outLen) {
  size_t nl = strlen(needle), rl = strlen(repl);
  size_t cap = srcLen + 64 + (rl > nl ? rl : 0) * 8;
  char *out = (char *)malloc(cap);
  size_t o = 0; int count = 0; size_t i = 0;
  if (!out) { *outPtr = NULL; *outLen = 0; return 0; }
  while (i < srcLen) {
    if (i + nl <= srcLen && memcmp(src + i, needle, nl) == 0) {
      memcpy(out + o, repl, rl); o += rl; i += nl; count++;
    } else {
      out[o++] = src[i++];
    }
    while (o + rl + 1 >= cap) { cap *= 2; out = (char *)realloc(out, cap); if (!out) { *outPtr = NULL; *outLen = 0; return 0; } }
  }
  *outPtr = out; *outLen = o;
  return count;
}

/* 反斜杠翻倍（rc 的 C 风格转义形式） */
static void escapeBs(const char *s, char *dst, size_t cap) {
  size_t o = 0;
  for (size_t i = 0; s[i] && o + 2 < cap; i++) {
    if (s[i] == '\\') dst[o++] = '\\';
    dst[o++] = s[i];
  }
  dst[o] = 0;
}

static int rewriteFile(const wchar_t *path, const char *n1, const char *r1, const char *n2, const char *r2, wchar_t *tmpOut, size_t tmpCap) {
  FILE *f = _wfopen(path, L"rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
  if (sz < 0) { fclose(f); return 0; }
  char *buf = (char *)malloc((size_t)sz + 1);
  if (!buf) { fclose(f); return 0; }
  size_t got = fread(buf, 1, (size_t)sz, f);
  fclose(f);
  char *b1 = NULL, *b2 = NULL; size_t l1 = 0, l2 = 0;
  int hits = rewriteU8(buf, got, n1, r1, &b1, &l1);
  if (b1) { hits += rewriteU8(b1, l1, n2, r2, &b2, &l2); free(b1); }
  else { b2 = (char *)malloc(got + 1); if (b2) { memcpy(b2, buf, got); l2 = got; } }
  free(buf);
  if (!b2 || hits == 0) { free(b2); return 0; }
  _snwprintf(tmpOut, tmpCap, L"%ls.mlascii", path);
  FILE *o = _wfopen(tmpOut, L"wb");
  if (!o) { free(b2); return 0; }
  fwrite(b2, 1, l2, o);
  fclose(o);
  free(b2);
  return 1;
}

int wmain(int argc, wchar_t **argv) {
  wchar_t realRoot[MAXW], asciiRoot[MAXW];
  DWORD n1 = GetEnvironmentVariableW(L"ML_REAL_ROOT", realRoot, MAXW);
  DWORD n2 = GetEnvironmentVariableW(L"ML_ASCII_ROOT", asciiRoot, MAXW);
  int ready = (n1 > 0 && n2 > 0 && n1 < MAXW && n2 < MAXW && wcscmp(realRoot, asciiRoot) != 0);

  wchar_t self[MAXW], realExe[MAXW * 2];
  GetModuleFileNameW(NULL, self, MAXW);
  wchar_t *slash = wcsrchr(self, L'\\');
  if (slash) *slash = 0;
  _snwprintf(realExe, MAXW * 2, L"%ls\\..\\binutils\\mingw64\\bin\\windres.exe", self);

  wchar_t tmpRc[MAXW * 2] = L"";
  wchar_t **args = (wchar_t **)calloc((size_t)argc + 1, sizeof(wchar_t *));
  for (int i = 0; i < argc; i++) args[i] = argv[i];

  if (ready) {
    char nb[MAXW * 6], rb[MAXW * 6], nb2[MAXW * 12], rb2[MAXW * 12];
    if (WideCharToMultiByte(CP_UTF8, 0, realRoot, -1, nb, sizeof(nb), NULL, NULL) > 1 &&
        WideCharToMultiByte(CP_UTF8, 0, asciiRoot, -1, rb, sizeof(rb), NULL, NULL) > 1) {
      escapeBs(nb, nb2, sizeof(nb2));
      escapeBs(rb, rb2, sizeof(rb2));
      for (int i = 1; i < argc - 0; i++) {
        int isInput = (wcscmp(argv[i], L"--input") == 0 || wcscmp(argv[i], L"-i") == 0 || wcsncmp(argv[i], L"--input=", 8) == 0);
        if (!isInput) continue;
        wchar_t *rcPath = (wcsncmp(argv[i], L"--input=", 8) == 0) ? argv[i] + 8 : argv[i + 1];
        if (!rcPath || !*rcPath) continue;
        if (rewriteFile(rcPath, nb, rb, nb2, rb2, tmpRc, MAXW * 2)) {
          if (rcPath == argv[i] + 8) {
            wchar_t *merged = (wchar_t *)malloc(MAXW * 2 * sizeof(wchar_t));
            _snwprintf(merged, MAXW * 2, L"--input=%ls", tmpRc);
            args[i] = merged;
          } else {
            args[i + 1] = tmpRc;
          }
        }
        break;  /* embed-resource 只传一个 --input */
      }
    }
  }

  /* 组装命令行（首 token 为程序路径） */
  wchar_t cmdLine[MAXW * 12]; size_t cl = 0;
  _snwprintf(cmdLine, MAXW * 12, L"\"%ls\"", realExe);
  cl = wcslen(cmdLine);
  for (int i = 1; i < argc; i++) {
    wchar_t quoted[MAXW * 2 + 2];
    if (wcschr(args[i], L' ')) _snwprintf(quoted, MAXW * 2 + 2, L"\"%ls\"", args[i]);
    else wcsncpy(quoted, args[i], MAXW * 2); quoted[MAXW * 2] = 0;
    size_t ql = wcslen(quoted);
    if (cl + ql + 2 >= MAXW * 12) break;
    cmdLine[cl++] = L' ';
    wcscpy(cmdLine + cl, quoted); cl += ql;
  }

  STARTUPINFOW si; ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
  PROCESS_INFORMATION pi; ZeroMemory(&pi, sizeof(pi));
  if (!CreateProcessW(realExe, cmdLine, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
    fwprintf(stderr, L"windres-shim: 无法启动 %ls (err=%lu)\n", realExe, GetLastError());
    return 127;
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
  if (tmpRc[0]) DeleteFileW(tmpRc);
  return (int)code;
}
