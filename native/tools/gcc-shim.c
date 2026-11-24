/* gcc-shim：windres 预处理直通 shim。
 *
 * 背景：tauri-winres 生成的 resource.rc 里烙有 CARGO_MANIFEST_DIR 的真实路径；项目路径含中文时
 * windres/gcc（内部按 UTF-8/ANSI 处理窄字符路径）打不开图标资源（Invalid argument）。
 *
 * 做法：run.ps1 创建 ASCII junction（ML_ASCII_ROOT）指向项目真实根（ML_REAL_ROOT）并导出环境变量；
 * 本 shim 位于 .tools\bin\gcc.exe（PATH 里排在真 gcc 前），把命令行参数与 `-E` 预处理输出中出现的
 * 真实根路径改写成 junction 路径后，转发给 ../binutils/mingw64/bin/gcc.exe。
 * 非 -E 调用（如 cc crate 的 -c 编译）原样透传，不改动输出流。
 *
 * 编译（须在 ASCII 工作目录下，见 native/toolchain.ps1）：
 *   gcc -O2 -o gcc.exe gcc-shim.c
 */
#include <windows.h>
#include <wchar.h>
#include <wctype.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define MAXW 1024

static wchar_t g_real[MAXW];   /* 项目真实根（如 C:\...\面灵ai\interview-orange） */
static wchar_t g_ascii[MAXW];  /* ASCII junction 根（如 C:\ml-src） */
static int g_ready = 0;

static void toLowerInPlace(wchar_t *s) { for (; *s; ++s) *s = (wchar_t)towlower(*s); }

/* 宽字符大小写不敏感子串替换（一次性展开到 out，返回替换次数） */
static int rewriteW(const wchar_t *in, const wchar_t *needleLower, const wchar_t *repl, wchar_t *out, size_t outCap) {
  int count = 0;
  size_t nl = wcslen(needleLower), rl = wcslen(repl);
  const wchar_t *p = in;
  wchar_t *o = out;
  while (*p) {
    if (nl && wcslen(p) >= nl) {
      wchar_t buf[MAXW];
      wcsncpy(buf, p, nl); buf[nl] = 0;
      toLowerInPlace(buf);
      if (wcscmp(buf, needleLower) == 0) {
        if ((size_t)(o - out) + rl >= outCap) return count;
        wcscpy(o, repl); o += rl; p += nl; count++; continue;
      }
    }
    if ((size_t)(o - out) + 1 >= outCap) break;
    *o++ = *p++;
  }
  *o = 0;
  return count;
}

/* 字节级 UTF-8 子串替换（memmem 语义），流式过滤用 */
static int rewriteU8(const char *src, size_t srcLen, const char *needle, const char *repl, char **outPtr, size_t *outLen) {
  size_t nl = strlen(needle), rl = strlen(repl);
  size_t cap = srcLen + (srcLen / 4 + 16) * (rl > nl ? rl - nl : 0) + 64;
  char *out = (char *)malloc(cap);
  size_t o = 0; int count = 0; size_t i = 0;
  if (!out) { *outPtr = NULL; *outLen = 0; return 0; }
  while (i < srcLen) {
    if (i + nl <= srcLen && memcmp(src + i, needle, nl) == 0) {
      memcpy(out + o, repl, rl); o += rl; i += nl; count++;
    } else {
      out[o++] = src[i++];
    }
    if (o + rl + 1 >= cap) { cap *= 2; out = (char *)realloc(out, cap); if (!out) { *outPtr = NULL; *outLen = 0; return 0; } }
  }
  *outPtr = out; *outLen = o;
  return count;
}

int wmain(int argc, wchar_t **argv) {
  wchar_t realLower[MAXW];
  DWORD n1 = GetEnvironmentVariableW(L"ML_REAL_ROOT", g_real, MAXW);
  DWORD n2 = GetEnvironmentVariableW(L"ML_ASCII_ROOT", g_ascii, MAXW);
  g_ready = (n1 > 0 && n2 > 0 && n1 < MAXW && n2 < MAXW && wcscmp(g_real, g_ascii) != 0);
  if (g_ready) { wcscpy(realLower, g_real); toLowerInPlace(realLower); }

  /* 调试日志：ML_SHIM_LOG 存在时追加每次调用（排查 windres 是否真走 shim） */
  {
    wchar_t logPath[MAXW];
    if (GetEnvironmentVariableW(L"ML_SHIM_LOG", logPath, MAXW) > 0) {
      FILE *lf = _wfopen(logPath, L"a");
      if (lf) {
        fwprintf(lf, L"argc=%d ready=%d argv0=%ls", argc, g_ready, argv[0]);
        for (int i = 1; i < argc && i < 12; i++) fwprintf(lf, L" [%ls]", argv[i]);
        fwprintf(lf, L"\n");
        fclose(lf);
      }
    }
  }

  /* 真 gcc 路径：从本 shim 位置推导 <root>\.tools\binutils\mingw64\bin\gcc.exe */
  wchar_t self[MAXW]; wchar_t realGcc[MAXW * 2];
  GetModuleFileNameW(NULL, self, MAXW);
  wchar_t *slash = wcsrchr(self, L'\\');
  if (slash) *slash = 0;                              /* …\.tools\bin */
  _snwprintf(realGcc, MAXW * 2, L"%s\\..\\binutils\\mingw64\\bin\\gcc.exe", self);

  /* 组装转发命令行：首 token 必须是程序路径（CreateProcessW 的 argv[0]），
   * 再逐个改写参数（真实根 → ASCII 根），并探测是否 -E */
  int isE = 0;
  wchar_t cmdLine[MAXW * 8]; size_t cl = 0;
  _snwprintf(cmdLine, MAXW * 8, L"\"%s\"", realGcc);
  cl = wcslen(cmdLine);
  for (int i = 1; i < argc; i++) {
    wchar_t arg[MAXW * 2];
    if (g_ready) rewriteW(argv[i], realLower, g_ascii, arg, MAXW * 2);
    else { wcsncpy(arg, argv[i], MAXW * 2 - 1); arg[MAXW * 2 - 1] = 0; }
    if (wcscmp(arg, L"-E") == 0) isE = 1;
    /* 引号包裹（保守转义：仅在含空格时） */
    wchar_t quoted[MAXW * 2 + 2];
    if (wcschr(arg, L' ')) _snwprintf(quoted, MAXW * 2 + 2, L"\"%s\"", arg);
    else wcscpy(quoted, arg);
    size_t ql = wcslen(quoted);
    if (cl + ql + 2 >= MAXW * 8) break;
    if (cl) cmdLine[cl++] = L' ';
    wcscpy(cmdLine + cl, quoted); cl += ql;
  }

  /* 子进程：-E 时接管 stdout 做路径改写，其余句柄全部继承 */
  SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
  HANDLE rd = NULL, wr = NULL;
  if (isE && g_ready) {
    if (!CreatePipe(&rd, &wr, &sa, 0)) { isE = 0; }
  }
  STARTUPINFOW si; ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
  PROCESS_INFORMATION pi; ZeroMemory(&pi, sizeof(pi));
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  si.hStdOutput = isE && g_ready ? wr : GetStdHandle(STD_OUTPUT_HANDLE);

  if (!CreateProcessW(realGcc, cmdLine, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
    fwprintf(stderr, L"gcc-shim: 无法启动 %ls (err=%lu)\n", realGcc, GetLastError());
    return 127;
  }
  if (isE && g_ready) CloseHandle(wr);

  if (isE && g_ready) {
    /* 流式读子进程 stdout，按块做 UTF-8 字节替换后转发。
     * resource.rc 里的路径是 C 风格转义（\\ 双反斜杠，gcc -E 不会折叠字符串转义），
     * 因此 needle 取两种形式：原样 + 反斜杠翻倍，两种都替换。 */
    char nbuf[MAXW * 6], rbuf[MAXW * 6];   /* 单反斜杠形式 */
    char nbuf2[MAXW * 12], rbuf2[MAXW * 12]; /* 双反斜杠形式 */
    int nb = WideCharToMultiByte(CP_UTF8, 0, g_real, -1, nbuf, sizeof(nbuf), NULL, NULL);
    int rb = WideCharToMultiByte(CP_UTF8, 0, g_ascii, -1, rbuf, sizeof(rbuf), NULL, NULL);
    /* 构造反斜杠翻倍形式：nbuf2 = escape(nbuf)，rbuf2 = escape(rbuf) */
    char *esc(const char *s, char *dst, size_t cap) {
      size_t o = 0;
      for (size_t i = 0; s[i] && o + 2 < cap; i++) {
        if (s[i] == '\\') dst[o++] = '\\';
        dst[o++] = s[i];
      }
      dst[o] = 0;
      return dst;
    }
    esc(nbuf, nbuf2, sizeof(nbuf2));
    esc(rbuf, rbuf2, sizeof(rbuf2));
    if (nb > 1 && rb > 1) {
      char chunk[65536];
      DWORD got = 0;
      /* 块边界可能切断 needle：保留尾部 maxNeedle-1 字节与下块拼接 */
      char pend[1024] = ""; size_t pendLen = 0;
      size_t nl = strlen(nbuf); size_t nl2 = strlen(nbuf2);
      size_t maxNl = nl > nl2 ? nl : nl2;
      while (ReadFile(rd, chunk, sizeof(chunk) - 1024, &got, NULL) && got > 0) {
        char *merged = chunk; size_t mergedLen = got;
        if (pendLen) { memmove(chunk + pendLen, chunk, got); memcpy(chunk, pend, pendLen); mergedLen += pendLen; }
        size_t keep = mergedLen > maxNl - 1 ? maxNl - 1 : mergedLen;
        if (mergedLen > keep) {
          char *outBuf = NULL; size_t outLen = 0;
          char *b1 = NULL, *b2 = NULL; size_t l1 = 0, l2 = 0;
          rewriteU8(merged, mergedLen - keep, nbuf, rbuf, &b1, &l1);
          if (b1) { rewriteU8(b1, l1, nbuf2, rbuf2, &b2, &l2); free(b1); }
          if (b2) { DWORD wr2 = 0; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), b2, (DWORD)l2, &wr2, NULL); free(b2); }
        }
        memcpy(pend, merged + mergedLen - keep, keep); pendLen = keep;
      }
      if (pendLen) {
        char *outBuf = NULL; size_t outLen = 0;
        char *b1 = NULL, *b2 = NULL; size_t l1 = 0, l2 = 0;
        rewriteU8(pend, pendLen, nbuf, rbuf, &b1, &l1);
        if (b1) { rewriteU8(b1, l1, nbuf2, rbuf2, &b2, &l2); free(b1); }
        if (b2) { DWORD wr2 = 0; WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), b2, (DWORD)l2, &wr2, NULL); free(b2); }
      }
    } else {
      char chunk[65536]; DWORD got = 0;
      while (ReadFile(rd, chunk, sizeof(chunk), &got, NULL) && got > 0)
        WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), chunk, got, &got, NULL);
    }
  }

  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
  if (rd) CloseHandle(rd);
  return (int)code;
}
