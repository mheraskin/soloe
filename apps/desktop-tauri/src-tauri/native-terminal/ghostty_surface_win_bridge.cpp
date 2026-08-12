// Windows WGL embedding behavior is adapted from the MIT-licensed Ghostty
// fork's electron-embed-windows example at the revision pinned by Soloe.
// See ../libghostty-LICENSE and ghostty-surface-source.json.

#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <windowsx.h>
#include <GL/gl.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <mutex>
#include <new>
#include <string>

#include "ghostty.h"
extern "C" {
#include "ghostty_surface_bridge.h"
}

constexpr wchar_t kWindowClass[] = L"SoloeGhosttyNativeTerminalWindow";
constexpr UINT kWakeupMessage = WM_APP + 0x317;
constexpr UINT kSelectionChangedMessage = WM_APP + 0x318;
constexpr UINT kRenderMessage = WM_APP + 0x319;
constexpr UINT kCopyCommand = 1;
constexpr UINT kPasteCommand = 2;
constexpr int kWglContextMajorVersionArb = 0x2091;
constexpr int kWglContextMinorVersionArb = 0x2092;
constexpr int kWglContextProfileMaskArb = 0x9126;
constexpr int kWglContextCoreProfileBitArb = 0x00000001;
constexpr int kWglContextCompatibilityProfileBitArb = 0x00000002;

using WglCreateContextAttribsArb = HGLRC(WINAPI *)(HDC, HGLRC, const int *);
using WglChoosePixelFormatFn = int(WINAPI *)(HDC, const PIXELFORMATDESCRIPTOR *);
using WglCreateContextFn = HGLRC(WINAPI *)(HDC);
using WglDeleteContextFn = BOOL(WINAPI *)(HGLRC);
using WglGetCurrentContextFn = HGLRC(WINAPI *)();
using WglGetProcAddressFn = PROC(WINAPI *)(LPCSTR);
using WglMakeCurrentFn = BOOL(WINAPI *)(HDC, HGLRC);
using WglSetPixelFormatFn = BOOL(WINAPI *)(HDC, int, const PIXELFORMATDESCRIPTOR *);
using WglSwapBuffersFn = BOOL(WINAPI *)(HDC);
using GlGetStringFn = const GLubyte *(APIENTRY *)(GLenum);

void Trace(const char *message) {
  char trace_path[MAX_PATH] = {};
  if (!message ||
      GetEnvironmentVariableA("GHOSTTY_EMBED_TRACE", trace_path,
                              static_cast<DWORD>(std::size(trace_path))) == 0)
    return;
  HANDLE trace = CreateFileA(trace_path, FILE_APPEND_DATA,
                             FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                             OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (trace == INVALID_HANDLE_VALUE) return;
  const char prefix[] = "[soloe-ghostty] ";
  const char newline[] = "\r\n";
  DWORD written = 0;
  WriteFile(trace, prefix, sizeof(prefix) - 1, &written, nullptr);
  WriteFile(trace, message, static_cast<DWORD>(std::strlen(message)), &written,
            nullptr);
  WriteFile(trace, newline, sizeof(newline) - 1, &written, nullptr);
  CloseHandle(trace);
}

void TraceValue(const char *event, uintptr_t value) {
  char message[128] = {};
  std::snprintf(message, std::size(message), "%s: %llu", event,
                static_cast<unsigned long long>(value));
  Trace(message);
}

struct SoloeGhosttyHost {};

struct SoloeGhosttySurface {
  ghostty_config_t config = nullptr;
  ghostty_app_t app = nullptr;
  ghostty_surface_t surface = nullptr;
  HWND parent = nullptr;
  HWND child = nullptr;
  HDC device_context = nullptr;
  HGLRC render_context = nullptr;
  HMODULE opengl_module = nullptr;
  WglChoosePixelFormatFn wgl_choose_pixel_format = nullptr;
  WglCreateContextFn wgl_create_context = nullptr;
  WglDeleteContextFn wgl_delete_context = nullptr;
  WglGetCurrentContextFn wgl_get_current_context = nullptr;
  WglGetProcAddressFn wgl_get_proc_address = nullptr;
  WglMakeCurrentFn wgl_make_current = nullptr;
  WglSetPixelFormatFn wgl_set_pixel_format = nullptr;
  WglSwapBuffersFn wgl_swap_buffers = nullptr;
  GlGetStringFn gl_get_string = nullptr;
  CRITICAL_SECTION context_lock = {};
  bool context_lock_initialized = false;
  std::atomic<bool> closing = false;
  std::atomic<bool> renderer_healthy = true;
  SoloeGhosttyBounds bounds = {};
  SoloeGhosttyConfiguration configuration = {};
  char *font_family = nullptr;
  char *background = nullptr;
  char *foreground = nullptr;
  bool visible = false;
  bool focused = false;
  bool left_captured = false;
  bool right_captured = false;
  wchar_t pending_high_surrogate = 0;
  int modifier_latch = GHOSTTY_MODS_NONE;
  void *event_userdata = nullptr;
  soloe_ghostty_bytes_cb input_cb = nullptr;
  soloe_ghostty_text_cb selection_cb = nullptr;
  soloe_ghostty_text_cb link_cb = nullptr;
};

std::string WideToUtf8(const wchar_t *value, int length = -1) {
  if (!value) return {};
  const int output_length =
      WideCharToMultiByte(CP_UTF8, 0, value, length, nullptr, 0, nullptr, nullptr);
  if (output_length <= 0) return {};
  std::string result(output_length, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, length, result.data(), output_length,
                      nullptr, nullptr);
  if (length == -1 && !result.empty() && result.back() == '\0') result.pop_back();
  return result;
}

std::wstring Utf8ToWide(const char *value) {
  if (!value) return {};
  const int output_length = MultiByteToWideChar(CP_UTF8, 0, value, -1, nullptr, 0);
  if (output_length <= 0) return {};
  std::wstring result(output_length, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value, -1, result.data(), output_length);
  return result;
}

int DipToPixel(HWND window, double value) {
  const UINT dpi = window ? GetDpiForWindow(window) : 96;
  const double scale = dpi > 0 ? static_cast<double>(dpi) / 96.0 : 1.0;
  return static_cast<int>(std::lround(value * scale));
}

ghostty_input_mods_e CurrentModifiers(const SoloeGhosttySurface *wrapper) {
  int mods = wrapper ? wrapper->modifier_latch : GHOSTTY_MODS_NONE;
  if (GetKeyState(VK_CAPITAL) & 1) mods |= GHOSTTY_MODS_CAPS;
  if (GetKeyState(VK_NUMLOCK) & 1) mods |= GHOSTTY_MODS_NUM;
  return static_cast<ghostty_input_mods_e>(mods);
}

void UpdateModifierLatch(SoloeGhosttySurface *wrapper,
                         WPARAM virtual_key,
                         LPARAM lparam,
                         bool down) {
  if (!wrapper) return;
  int bits = 0;
  switch (virtual_key) {
    case VK_SHIFT:
    case VK_LSHIFT:
    case VK_RSHIFT: {
      bits = GHOSTTY_MODS_SHIFT;
      const UINT scan_code = static_cast<UINT>((lparam >> 16) & 0xff);
      const UINT resolved = virtual_key == VK_SHIFT
                                ? MapVirtualKeyW(scan_code, MAPVK_VSC_TO_VK_EX)
                                : static_cast<UINT>(virtual_key);
      if (resolved == VK_RSHIFT) bits |= GHOSTTY_MODS_SHIFT_RIGHT;
      break;
    }
    case VK_CONTROL:
    case VK_LCONTROL:
    case VK_RCONTROL:
      bits = GHOSTTY_MODS_CTRL;
      if (virtual_key == VK_RCONTROL || (lparam & (1LL << 24)))
        bits |= GHOSTTY_MODS_CTRL_RIGHT;
      break;
    case VK_MENU:
    case VK_LMENU:
    case VK_RMENU:
      bits = GHOSTTY_MODS_ALT;
      if (virtual_key == VK_RMENU || (lparam & (1LL << 24)))
        bits |= GHOSTTY_MODS_ALT_RIGHT;
      break;
    case VK_LWIN:
    case VK_RWIN:
      bits = GHOSTTY_MODS_SUPER;
      if (virtual_key == VK_RWIN) bits |= GHOSTTY_MODS_SUPER_RIGHT;
      break;
    default:
      return;
  }
  if (down)
    wrapper->modifier_latch |= bits;
  else
    wrapper->modifier_latch &= ~bits;
}

uint32_t NativeScanCode(LPARAM lparam) {
  uint32_t code = static_cast<uint32_t>((lparam >> 16) & 0xff);
  if ((lparam & (1LL << 24)) != 0) code |= 0xe000;
  return code;
}

uint32_t UnshiftedCodepoint(WPARAM virtual_key) {
  if (virtual_key >= 'A' && virtual_key <= 'Z')
    return static_cast<uint32_t>('a' + (virtual_key - 'A'));
  if (virtual_key >= '0' && virtual_key <= '9')
    return static_cast<uint32_t>(virtual_key);
  return 0;
}

bool IsTextProducingKey(WPARAM virtual_key) {
  return virtual_key == VK_SPACE ||
         (virtual_key >= '0' && virtual_key <= '9') ||
         (virtual_key >= 'A' && virtual_key <= 'Z') ||
         (virtual_key >= VK_NUMPAD0 && virtual_key <= VK_DIVIDE) ||
         (virtual_key >= VK_OEM_1 && virtual_key <= VK_OEM_8) ||
         virtual_key == VK_OEM_102;
}

bool HasCommandModifier(const SoloeGhosttySurface *wrapper) {
  return wrapper &&
         (wrapper->modifier_latch &
          (GHOSTTY_MODS_CTRL | GHOSTTY_MODS_ALT | GHOSTTY_MODS_SUPER));
}

void EmitSelection(SoloeGhosttySurface *wrapper) {
  if (!wrapper || !wrapper->surface || !wrapper->selection_cb) return;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_selection_clipboard_text(wrapper->surface,
                                                     16 * 1024 * 1024, &text)) {
    wrapper->selection_cb(wrapper->event_userdata, "", 0);
    return;
  }
  wrapper->selection_cb(wrapper->event_userdata, text.text, text.text_len);
  ghostty_surface_free_text(wrapper->surface, &text);
}

void SendMousePosition(SoloeGhosttySurface *wrapper, LPARAM lparam) {
  if (!wrapper || !wrapper->surface) return;
  ghostty_surface_mouse_pos(wrapper->surface, GET_X_LPARAM(lparam),
                           GET_Y_LPARAM(lparam), CurrentModifiers(wrapper));
}

void UpdateSurfaceMetrics(SoloeGhosttySurface *wrapper) {
  if (!wrapper || !wrapper->surface || !wrapper->child) return;
  RECT bounds = {};
  if (!GetClientRect(wrapper->child, &bounds)) return;
  const UINT dpi = GetDpiForWindow(wrapper->child);
  const double scale = dpi > 0 ? static_cast<double>(dpi) / 96.0 : 1.0;
  ghostty_surface_set_content_scale(wrapper->surface, scale, scale);
  ghostty_surface_set_size(
      wrapper->surface, static_cast<uint32_t>(std::max(1L, bounds.right)),
      static_cast<uint32_t>(std::max(1L, bounds.bottom)));
}

void *WglGetProcAddress(void *userdata, const char *name) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (!wrapper || !name || !wrapper->wgl_get_proc_address) return nullptr;
  PROC proc = wrapper->wgl_get_proc_address(name);
  if (proc && proc != reinterpret_cast<PROC>(1) &&
      proc != reinterpret_cast<PROC>(2) && proc != reinterpret_cast<PROC>(3) &&
      proc != reinterpret_cast<PROC>(-1)) {
    return reinterpret_cast<void *>(proc);
  }
  return wrapper->opengl_module
             ? reinterpret_cast<void *>(GetProcAddress(wrapper->opengl_module, name))
             : nullptr;
}

bool WglMakeCurrent(void *userdata) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (!wrapper || !wrapper->device_context || !wrapper->render_context)
    return false;
  EnterCriticalSection(&wrapper->context_lock);
  if (!wrapper->wgl_make_current(wrapper->device_context,
                                 wrapper->render_context)) {
    LeaveCriticalSection(&wrapper->context_lock);
    return false;
  }
  return true;
}

void WglClearCurrent(void *userdata) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (!wrapper) return;
  wrapper->wgl_make_current(nullptr, nullptr);
  LeaveCriticalSection(&wrapper->context_lock);
}

void WglSwapBuffers(void *userdata) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (!wrapper || !wrapper->device_context) return;
  if (!wrapper->wgl_swap_buffers(wrapper->device_context))
    wrapper->renderer_healthy.store(false, std::memory_order_release);
}

bool VersionAtLeast43(const char *version) {
  if (!version) return false;
  int major = 0;
  int minor = 0;
  return std::sscanf(version, "%d.%d", &major, &minor) == 2 &&
         (major > 4 || (major == 4 && minor >= 3));
}

bool LoadWglApi(SoloeGhosttySurface *wrapper) {
  wchar_t override_path[MAX_PATH] = {};
  const DWORD override_length = GetEnvironmentVariableW(
      L"GHOSTTY_MESA_OPENGL_PATH", override_path,
      static_cast<DWORD>(std::size(override_path)));
  const bool override = override_length > 0 && override_length < std::size(override_path);
  wrapper->opengl_module = override
                               ? LoadLibraryExW(override_path, nullptr,
                                                LOAD_WITH_ALTERED_SEARCH_PATH)
                               : LoadLibraryW(L"opengl32.dll");
  if (!wrapper->opengl_module) return false;
  const auto load = [wrapper](const char *name) {
    return GetProcAddress(wrapper->opengl_module, name);
  };
  wrapper->wgl_create_context =
      reinterpret_cast<WglCreateContextFn>(load("wglCreateContext"));
  wrapper->wgl_delete_context =
      reinterpret_cast<WglDeleteContextFn>(load("wglDeleteContext"));
  wrapper->wgl_get_current_context =
      reinterpret_cast<WglGetCurrentContextFn>(load("wglGetCurrentContext"));
  wrapper->wgl_get_proc_address =
      reinterpret_cast<WglGetProcAddressFn>(load("wglGetProcAddress"));
  wrapper->wgl_make_current =
      reinterpret_cast<WglMakeCurrentFn>(load("wglMakeCurrent"));
  wrapper->gl_get_string = reinterpret_cast<GlGetStringFn>(load("glGetString"));
  if (override) {
    wrapper->wgl_choose_pixel_format =
        reinterpret_cast<WglChoosePixelFormatFn>(load("wglChoosePixelFormat"));
    wrapper->wgl_set_pixel_format =
        reinterpret_cast<WglSetPixelFormatFn>(load("wglSetPixelFormat"));
    wrapper->wgl_swap_buffers =
        reinterpret_cast<WglSwapBuffersFn>(load("wglSwapBuffers"));
  } else {
    wrapper->wgl_choose_pixel_format = &::ChoosePixelFormat;
    wrapper->wgl_set_pixel_format = &::SetPixelFormat;
    wrapper->wgl_swap_buffers = &::SwapBuffers;
  }
  return wrapper->wgl_choose_pixel_format && wrapper->wgl_create_context &&
         wrapper->wgl_delete_context && wrapper->wgl_get_current_context &&
         wrapper->wgl_get_proc_address && wrapper->wgl_make_current &&
         wrapper->wgl_set_pixel_format && wrapper->wgl_swap_buffers &&
         wrapper->gl_get_string;
}

bool InitializeWgl(SoloeGhosttySurface *wrapper) {
  if (!LoadWglApi(wrapper)) return false;
  wrapper->device_context = GetDC(wrapper->child);
  if (!wrapper->device_context) return false;
  PIXELFORMATDESCRIPTOR format = {};
  format.nSize = sizeof(format);
  format.nVersion = 1;
  format.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
  format.iPixelType = PFD_TYPE_RGBA;
  format.cColorBits = 32;
  format.cAlphaBits = 8;
  format.cDepthBits = 24;
  format.cStencilBits = 8;
  format.iLayerType = PFD_MAIN_PLANE;
  const int pixel_format =
      wrapper->wgl_choose_pixel_format(wrapper->device_context, &format);
  if (pixel_format == 0 ||
      !wrapper->wgl_set_pixel_format(wrapper->device_context, pixel_format, &format))
    return false;
  HGLRC legacy = wrapper->wgl_create_context(wrapper->device_context);
  if (!legacy || !wrapper->wgl_make_current(wrapper->device_context, legacy)) {
    if (legacy) wrapper->wgl_delete_context(legacy);
    return false;
  }
  auto create_context = reinterpret_cast<WglCreateContextAttribsArb>(
      wrapper->wgl_get_proc_address("wglCreateContextAttribsARB"));
  HGLRC modern = nullptr;
  if (create_context) {
    const int profiles[] = {kWglContextCoreProfileBitArb,
                            kWglContextCompatibilityProfileBitArb};
    const int versions[][2] = {{4, 5}, {4, 3}};
    for (const auto &version : versions) {
      for (const int profile : profiles) {
        const int attributes[] = {
            kWglContextMajorVersionArb, version[0],
            kWglContextMinorVersionArb, version[1],
            kWglContextProfileMaskArb, profile, 0};
        modern = create_context(wrapper->device_context, nullptr, attributes);
        if (modern) break;
      }
      if (modern) break;
    }
  }
  if (modern) {
    wrapper->wgl_make_current(nullptr, nullptr);
    wrapper->wgl_delete_context(legacy);
    wrapper->render_context = modern;
    if (!wrapper->wgl_make_current(wrapper->device_context,
                                   wrapper->render_context))
      return false;
  } else {
    wrapper->render_context = legacy;
  }
  const char *version =
      reinterpret_cast<const char *>(wrapper->gl_get_string(GL_VERSION));
  const bool supported = VersionAtLeast43(version);
  wrapper->wgl_make_current(nullptr, nullptr);
  return supported;
}

void DestroyWgl(SoloeGhosttySurface *wrapper) {
  if (!wrapper) return;
  if (wrapper->render_context && wrapper->wgl_get_current_context &&
      wrapper->wgl_get_current_context() == wrapper->render_context) {
    wrapper->wgl_make_current(nullptr, nullptr);
    LeaveCriticalSection(&wrapper->context_lock);
  }
  if (wrapper->context_lock_initialized)
    EnterCriticalSection(&wrapper->context_lock);
  if (wrapper->render_context) {
    wrapper->wgl_delete_context(wrapper->render_context);
    wrapper->render_context = nullptr;
  }
  if (wrapper->device_context && wrapper->child) {
    ReleaseDC(wrapper->child, wrapper->device_context);
    wrapper->device_context = nullptr;
  }
  if (wrapper->context_lock_initialized) {
    LeaveCriticalSection(&wrapper->context_lock);
    DeleteCriticalSection(&wrapper->context_lock);
    wrapper->context_lock_initialized = false;
  }
  if (wrapper->opengl_module) {
    FreeLibrary(wrapper->opengl_module);
    wrapper->opengl_module = nullptr;
  }
}

bool ReadClipboard(void *userdata, ghostty_clipboard_e type, void *request) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (!wrapper || !wrapper->surface || type != GHOSTTY_CLIPBOARD_STANDARD ||
      !OpenClipboard(wrapper->child))
    return false;
  HANDLE handle = GetClipboardData(CF_UNICODETEXT);
  const wchar_t *value =
      handle ? static_cast<const wchar_t *>(GlobalLock(handle)) : nullptr;
  const std::string utf8 = value ? WideToUtf8(value) : std::string();
  if (value) GlobalUnlock(handle);
  CloseClipboard();
  if (utf8.empty()) return false;
  ghostty_surface_complete_clipboard_request(wrapper->surface, utf8.c_str(),
                                             request, false);
  return true;
}

void ConfirmReadClipboard(void *userdata,
                          const char *value,
                          void *request,
                          ghostty_clipboard_request_e) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (wrapper && wrapper->surface)
    ghostty_surface_complete_clipboard_request(wrapper->surface, value, request,
                                               false);
}

void WriteClipboard(void *userdata,
                    ghostty_clipboard_e type,
                    const ghostty_clipboard_content_s *content,
                    size_t count,
                    bool) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (!wrapper || type != GHOSTTY_CLIPBOARD_STANDARD || !content) return;
  for (size_t index = 0; index < count; ++index) {
    if (!content[index].mime || !content[index].data ||
        std::strcmp(content[index].mime, "text/plain") != 0)
      continue;
    const std::wstring wide = Utf8ToWide(content[index].data);
    if (wide.empty() || !OpenClipboard(wrapper->child)) return;
    EmptyClipboard();
    const SIZE_T bytes = wide.size() * sizeof(wchar_t);
    HGLOBAL allocation = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (allocation) {
      void *destination = GlobalLock(allocation);
      if (destination) {
        std::memcpy(destination, wide.data(), bytes);
        GlobalUnlock(allocation);
        if (!SetClipboardData(CF_UNICODETEXT, allocation)) GlobalFree(allocation);
      } else {
        GlobalFree(allocation);
      }
    }
    CloseClipboard();
    return;
  }
}

void Wakeup(void *userdata) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (wrapper && !wrapper->closing.load(std::memory_order_acquire) &&
      wrapper->child)
    PostMessageW(wrapper->child, kWakeupMessage, 0, 0);
}

bool Action(ghostty_app_t app, ghostty_target_s, ghostty_action_s action) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(ghostty_app_userdata(app));
  if (!wrapper) return false;
  if (wrapper->closing.load(std::memory_order_acquire))
    return action.tag == GHOSTTY_ACTION_RENDER ||
           action.tag == GHOSTTY_ACTION_RENDERER_HEALTH;
  TraceValue("action", static_cast<uintptr_t>(action.tag));
  switch (action.tag) {
    case GHOSTTY_ACTION_RENDER:
      // app_tick can publish render while Ghostty still owns internal state.
      // Calling refresh here re-enters the same surface and deadlocks the
      // Win32 message thread after a replay. Schedule it after the callback
      // and app tick have unwound instead.
      if (wrapper->child)
        PostMessageW(wrapper->child, kRenderMessage, 0, 0);
      return true;
    case GHOSTTY_ACTION_RENDERER_HEALTH:
      wrapper->renderer_healthy.store(
          action.action.renderer_health == GHOSTTY_RENDERER_HEALTH_HEALTHY,
          std::memory_order_release);
      return true;
    case GHOSTTY_ACTION_SELECTION_CHANGED:
      // Ghostty can publish this action while its renderer-state mutex is
      // held. Reading the selection from inside the callback re-enters the
      // surface and deadlocks the Tauri window thread. Defer the read until
      // the current Ghostty callback and app tick have fully unwound.
      if (wrapper->child)
        PostMessageW(wrapper->child, kSelectionChangedMessage, 0, 0);
      return true;
    case GHOSTTY_ACTION_OPEN_URL:
      if (wrapper->link_cb && action.action.open_url.url)
        wrapper->link_cb(wrapper->event_userdata, action.action.open_url.url,
                         action.action.open_url.len);
      return true;
    default:
      return false;
  }
}

void CloseSurface(void *, bool) {}

void IoWrite(void *userdata, const char *bytes, uintptr_t length) {
  auto *wrapper = static_cast<SoloeGhosttySurface *>(userdata);
  if (wrapper && wrapper->input_cb && bytes && length > 0)
    wrapper->input_cb(wrapper->event_userdata,
                      reinterpret_cast<const uint8_t *>(bytes), length);
}

bool EnsureGhosttyInitialized() {
  static std::once_flag once;
  static int result = -1;
  std::call_once(once, [] {
    char process_name[] = "soloe-libghostty-windows";
    char *argv[] = {process_name};
    result = ghostty_init(1, argv);
  });
  return result == GHOSTTY_SUCCESS;
}

std::string SafeConfigValue(const char *value) {
  std::string result = value ? value : "";
  std::replace(result.begin(), result.end(), '\n', ' ');
  std::replace(result.begin(), result.end(), '\r', ' ');
  return result;
}

ghostty_config_t SurfaceConfig(SoloeGhosttyConfiguration configuration) {
  ghostty_config_t config = ghostty_config_new();
  if (!config) return nullptr;
  ghostty_config_load_default_files(config);
  ghostty_config_load_recursive_files(config);
  const std::string source =
      "font-family = " + SafeConfigValue(configuration.font_family) + "\n" +
      "font-size = " + std::to_string(std::max(6.0, configuration.font_size)) +
      "\nbackground = " + SafeConfigValue(configuration.background) +
      "\nforeground = " + SafeConfigValue(configuration.foreground) + "\n";
  ghostty_config_load_string(config, source.c_str(), source.size(),
                            "soloe-terminal-presentation");
  ghostty_config_finalize(config);
  return config;
}

bool AssignConfiguration(SoloeGhosttySurface *wrapper,
                         SoloeGhosttyConfiguration configuration) {
  char *font_family = _strdup(configuration.font_family ? configuration.font_family : "");
  char *background = _strdup(configuration.background ? configuration.background : "");
  char *foreground = _strdup(configuration.foreground ? configuration.foreground : "");
  if (!font_family || !background || !foreground) {
    free(font_family);
    free(background);
    free(foreground);
    return false;
  }
  free(wrapper->font_family);
  free(wrapper->background);
  free(wrapper->foreground);
  wrapper->font_family = font_family;
  wrapper->background = background;
  wrapper->foreground = foreground;
  wrapper->configuration = configuration;
  wrapper->configuration.font_family = wrapper->font_family;
  wrapper->configuration.background = wrapper->background;
  wrapper->configuration.foreground = wrapper->foreground;
  return true;
}

bool CreateInnerSurface(SoloeGhosttySurface *wrapper) {
  ghostty_surface_config_s options = ghostty_surface_config_new();
  options.platform_tag = GHOSTTY_PLATFORM_OPENGL;
  options.platform.opengl.userdata = wrapper;
  options.platform.opengl.make_current = WglMakeCurrent;
  options.platform.opengl.clear_current = WglClearCurrent;
  options.platform.opengl.get_proc_address = WglGetProcAddress;
  options.platform.opengl.swap_buffers = WglSwapBuffers;
  options.userdata = wrapper;
  const UINT dpi = GetDpiForWindow(wrapper->child);
  options.scale_factor = dpi > 0 ? static_cast<double>(dpi) / 96.0 : 1.0;
  options.font_size = static_cast<float>(std::max(6.0, wrapper->configuration.font_size));
  options.working_directory = nullptr;
  options.command = nullptr;
  options.env_vars = nullptr;
  options.env_var_count = 0;
  options.initial_input = nullptr;
  options.wait_after_command = false;
  options.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;
  options.io_mode = GHOSTTY_SURFACE_IO_MANUAL;
  options.io_write_cb = IoWrite;
  options.io_write_userdata = wrapper;
  const size_t scrollback_limit =
      wrapper->configuration.scrollback > SIZE_MAX / 1024
          ? SIZE_MAX
          : wrapper->configuration.scrollback * 1024;
  wrapper->surface = ghostty_surface_new_with_scrollback_limit(
      wrapper->app, &options, scrollback_limit);
  if (!wrapper->surface) return false;
  ghostty_config_t config = SurfaceConfig(wrapper->configuration);
  if (config) {
    ghostty_surface_update_config(wrapper->surface, config);
    ghostty_config_free(config);
  }
  UpdateSurfaceMetrics(wrapper);
  ghostty_surface_set_occlusion(wrapper->surface, wrapper->visible);
  ghostty_surface_set_focus(wrapper->surface, wrapper->focused);
  ghostty_surface_refresh(wrapper->surface);
  return true;
}

void SendKey(SoloeGhosttySurface *wrapper,
             ghostty_input_action_e action,
             WPARAM virtual_key,
             LPARAM lparam) {
  if (!wrapper || !wrapper->surface) return;
  ghostty_input_key_s key = {};
  key.action = action;
  key.mods = CurrentModifiers(wrapper);
  key.consumed_mods = GHOSTTY_MODS_NONE;
  key.keycode = NativeScanCode(lparam);
  key.unshifted_codepoint = UnshiftedCodepoint(virtual_key);
  key.text = nullptr;
  ghostty_surface_key(wrapper->surface, key);
}

void SendUtf16Character(SoloeGhosttySurface *wrapper, wchar_t character) {
  if (!wrapper || !wrapper->surface) return;
  if (character >= 0xd800 && character <= 0xdbff) {
    wrapper->pending_high_surrogate = character;
    return;
  }
  wchar_t utf16[3] = {};
  int length = 1;
  if (character >= 0xdc00 && character <= 0xdfff &&
      wrapper->pending_high_surrogate) {
    utf16[0] = wrapper->pending_high_surrogate;
    utf16[1] = character;
    length = 2;
  } else {
    utf16[0] = character;
  }
  wrapper->pending_high_surrogate = 0;
  const std::string utf8 = WideToUtf8(utf16, length);
  if (!utf8.empty())
    ghostty_surface_text_input(wrapper->surface, utf8.data(), utf8.size());
}

void InvokeBinding(SoloeGhosttySurface *wrapper, const char *action) {
  if (wrapper && wrapper->surface && action)
    ghostty_surface_binding_action(wrapper->surface, action, std::strlen(action));
}

void ShowContextMenu(SoloeGhosttySurface *wrapper, LPARAM lparam) {
  if (!wrapper || !wrapper->child) return;
  HMENU menu = CreatePopupMenu();
  if (!menu) return;
  const bool selected =
      wrapper->surface && ghostty_surface_has_selection(wrapper->surface);
  AppendMenuW(menu, MF_STRING | (selected ? MF_ENABLED : MF_GRAYED),
              kCopyCommand, L"Copy");
  AppendMenuW(menu,
              MF_STRING | (IsClipboardFormatAvailable(CF_UNICODETEXT)
                               ? MF_ENABLED
                               : MF_GRAYED),
              kPasteCommand, L"Paste");
  POINT point = {GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};
  ClientToScreen(wrapper->child, &point);
  const UINT command = TrackPopupMenu(
      menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, point.x, point.y, 0,
      wrapper->child, nullptr);
  DestroyMenu(menu);
  if (command == kCopyCommand)
    InvokeBinding(wrapper, "copy_to_clipboard");
  else if (command == kPasteCommand)
    InvokeBinding(wrapper, "paste_from_clipboard");
}

LRESULT CALLBACK TerminalWindowProc(HWND window,
                                    UINT message,
                                    WPARAM wparam,
                                    LPARAM lparam) {
  auto *wrapper = reinterpret_cast<SoloeGhosttySurface *>(
      GetWindowLongPtrW(window, GWLP_USERDATA));
  if (message == WM_NCCREATE) {
    const auto *create = reinterpret_cast<CREATESTRUCTW *>(lparam);
    wrapper = static_cast<SoloeGhosttySurface *>(create->lpCreateParams);
    SetWindowLongPtrW(window, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(wrapper));
  }
  if (!wrapper) return DefWindowProcW(window, message, wparam, lparam);
  switch (message) {
    case kWakeupMessage:
      Trace("app tick: entered");
      if (!wrapper->closing.load(std::memory_order_acquire) && wrapper->app)
        ghostty_app_tick(wrapper->app);
      Trace("app tick: complete");
      return 0;
    case kSelectionChangedMessage:
      if (!wrapper->closing.load(std::memory_order_acquire))
        EmitSelection(wrapper);
      return 0;
    case kRenderMessage:
      Trace("render message: entered");
      if (!wrapper->closing.load(std::memory_order_acquire) && wrapper->surface)
        ghostty_surface_refresh(wrapper->surface);
      Trace("render message: complete");
      return 0;
    case WM_SIZE:
    case WM_DPICHANGED_AFTERPARENT:
      UpdateSurfaceMetrics(wrapper);
      if (wrapper->surface) ghostty_surface_refresh(wrapper->surface);
      return 0;
    case WM_SHOWWINDOW:
      if (wrapper->surface)
        ghostty_surface_set_occlusion(wrapper->surface, wparam != 0);
      return 0;
    case WM_SETFOCUS:
      if (wrapper->app) ghostty_app_set_focus(wrapper->app, true);
      if (wrapper->surface) ghostty_surface_set_focus(wrapper->surface, true);
      return 0;
    case WM_KILLFOCUS:
      wrapper->modifier_latch = GHOSTTY_MODS_NONE;
      if (wrapper->surface) ghostty_surface_set_focus(wrapper->surface, false);
      if (wrapper->app) ghostty_app_set_focus(wrapper->app, false);
      return 0;
    case WM_LBUTTONDOWN:
      SetFocus(window);
      SetCapture(window);
      wrapper->left_captured = true;
      SendMousePosition(wrapper, lparam);
      if (wrapper->surface)
        ghostty_surface_mouse_button(wrapper->surface, GHOSTTY_MOUSE_PRESS,
                                     GHOSTTY_MOUSE_LEFT,
                                     CurrentModifiers(wrapper));
      return 0;
    case WM_LBUTTONUP:
      SendMousePosition(wrapper, lparam);
      if (wrapper->surface)
        ghostty_surface_mouse_button(wrapper->surface, GHOSTTY_MOUSE_RELEASE,
                                     GHOSTTY_MOUSE_LEFT,
                                     CurrentModifiers(wrapper));
      if (wrapper->left_captured) {
        ReleaseCapture();
        wrapper->left_captured = false;
      }
      EmitSelection(wrapper);
      return 0;
    case WM_RBUTTONDOWN:
      SetFocus(window);
      SendMousePosition(wrapper, lparam);
      wrapper->right_captured =
          wrapper->surface && ghostty_surface_mouse_captured(wrapper->surface);
      if (wrapper->right_captured) {
        SetCapture(window);
        ghostty_surface_mouse_button(wrapper->surface, GHOSTTY_MOUSE_PRESS,
                                     GHOSTTY_MOUSE_RIGHT,
                                     CurrentModifiers(wrapper));
      } else {
        ShowContextMenu(wrapper, lparam);
      }
      return 0;
    case WM_RBUTTONUP:
      if (wrapper->right_captured && wrapper->surface) {
        SendMousePosition(wrapper, lparam);
        ghostty_surface_mouse_button(wrapper->surface, GHOSTTY_MOUSE_RELEASE,
                                     GHOSTTY_MOUSE_RIGHT,
                                     CurrentModifiers(wrapper));
        ReleaseCapture();
        wrapper->right_captured = false;
      }
      return 0;
    case WM_MOUSEMOVE:
      SendMousePosition(wrapper, lparam);
      return 0;
    case WM_MOUSEWHEEL:
    case WM_MOUSEHWHEEL:
      if (wrapper->surface) {
        const double delta =
            static_cast<double>(GET_WHEEL_DELTA_WPARAM(wparam)) / WHEEL_DELTA;
        ghostty_surface_mouse_scroll(
            wrapper->surface, message == WM_MOUSEHWHEEL ? delta : 0.0,
            message == WM_MOUSEWHEEL ? delta : 0.0, 0);
      }
      return 0;
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
      if (message == WM_SYSKEYDOWN && wparam == VK_TAB) return 0;
      UpdateModifierLatch(wrapper, wparam, lparam, true);
      if (IsTextProducingKey(wparam) && !HasCommandModifier(wrapper)) return 0;
      SendKey(wrapper, (lparam & (1LL << 30)) ? GHOSTTY_ACTION_REPEAT
                                              : GHOSTTY_ACTION_PRESS,
              wparam, lparam);
      return 0;
    case WM_KEYUP:
    case WM_SYSKEYUP:
      if (message == WM_SYSKEYUP && wparam == VK_TAB) return 0;
      if (IsTextProducingKey(wparam) && !HasCommandModifier(wrapper)) {
        UpdateModifierLatch(wrapper, wparam, lparam, false);
        return 0;
      }
      SendKey(wrapper, GHOSTTY_ACTION_RELEASE, wparam, lparam);
      UpdateModifierLatch(wrapper, wparam, lparam, false);
      return 0;
    case WM_CHAR:
      if (wparam >= 0x20 && wparam != 0x7f)
        SendUtf16Character(wrapper, static_cast<wchar_t>(wparam));
      return 0;
    case WM_UNICHAR:
      if (wparam == UNICODE_NOCHAR) return TRUE;
      if (wparam <= 0xffff) {
        SendUtf16Character(wrapper, static_cast<wchar_t>(wparam));
      } else if (wparam <= 0x10ffff) {
        const uint32_t codepoint = static_cast<uint32_t>(wparam) - 0x10000;
        SendUtf16Character(wrapper,
                           static_cast<wchar_t>(0xd800 + (codepoint >> 10)));
        SendUtf16Character(wrapper,
                           static_cast<wchar_t>(0xdc00 + (codepoint & 0x3ff)));
      }
      return 0;
    case WM_SYSCHAR:
      return 0;
    case WM_SETCURSOR:
      SetCursor(LoadCursorW(nullptr, MAKEINTRESOURCEW(32513)));
      return TRUE;
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT paint = {};
      BeginPaint(window, &paint);
      EndPaint(window, &paint);
      if (wrapper->surface) ghostty_surface_refresh(wrapper->surface);
      return 0;
    }
    case WM_NCDESTROY:
      SetWindowLongPtrW(window, GWLP_USERDATA, 0);
      return DefWindowProcW(window, message, wparam, lparam);
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
}

bool EnsureWindowClass() {
  static std::once_flag once;
  static bool success = false;
  std::call_once(once, [] {
    WNDCLASSEXW window_class = {};
    window_class.cbSize = sizeof(window_class);
    window_class.style = CS_OWNDC | CS_HREDRAW | CS_VREDRAW;
    window_class.lpfnWndProc = TerminalWindowProc;
    window_class.hInstance = GetModuleHandleW(nullptr);
    window_class.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32513));
    window_class.hbrBackground =
        static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    window_class.lpszClassName = kWindowClass;
    success = RegisterClassExW(&window_class) != 0 ||
              GetLastError() == ERROR_CLASS_ALREADY_EXISTS;
  });
  return success;
}

void DestroySurface(SoloeGhosttySurface *wrapper) {
  if (!wrapper || wrapper->closing.exchange(true, std::memory_order_acq_rel))
    return;
  if (wrapper->surface) {
    ghostty_surface_set_focus(wrapper->surface, false);
    ghostty_surface_free(wrapper->surface);
    wrapper->surface = nullptr;
  }
  if (wrapper->app) {
    ghostty_app_free(wrapper->app);
    wrapper->app = nullptr;
  }
  if (wrapper->config) {
    ghostty_config_free(wrapper->config);
    wrapper->config = nullptr;
  }
  DestroyWgl(wrapper);
  if (wrapper->child) {
    SetWindowLongPtrW(wrapper->child, GWLP_USERDATA, 0);
    DestroyWindow(wrapper->child);
    wrapper->child = nullptr;
  }
  free(wrapper->font_family);
  free(wrapper->background);
  free(wrapper->foreground);
  wrapper->font_family = nullptr;
  wrapper->background = nullptr;
  wrapper->foreground = nullptr;
}

extern "C" {

SoloeGhosttyHost *soloe_ghostty_host_new(void) {
  if (!EnsureWindowClass() || !EnsureGhosttyInitialized()) return nullptr;
  return new (std::nothrow) SoloeGhosttyHost();
}

void soloe_ghostty_host_free(SoloeGhosttyHost *host) { delete host; }

SoloeGhosttySurface *soloe_ghostty_surface_new(
    SoloeGhosttyHost *host,
    void *parent_hwnd,
    SoloeGhosttyBounds bounds,
    SoloeGhosttyConfiguration configuration,
    bool visible,
    bool focused,
    void *event_userdata,
    soloe_ghostty_bytes_cb input_cb,
    soloe_ghostty_text_cb selection_cb,
    soloe_ghostty_text_cb link_cb) {
  Trace("surface new: entered");
  auto parent = static_cast<HWND>(parent_hwnd);
  if (!host || !parent || !IsWindow(parent)) return nullptr;
  auto *wrapper = new (std::nothrow) SoloeGhosttySurface();
  if (!wrapper) return nullptr;
  wrapper->parent = parent;
  wrapper->bounds = bounds;
  wrapper->visible = visible;
  wrapper->focused = focused;
  wrapper->event_userdata = event_userdata;
  wrapper->input_cb = input_cb;
  wrapper->selection_cb = selection_cb;
  wrapper->link_cb = link_cb;
  if (!AssignConfiguration(wrapper, configuration)) {
    delete wrapper;
    return nullptr;
  }
  InitializeCriticalSection(&wrapper->context_lock);
  wrapper->context_lock_initialized = true;
  wrapper->child = CreateWindowExW(
      0, kWindowClass, L"Soloe Ghostty terminal",
      WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN | WS_TABSTOP,
      DipToPixel(parent, bounds.x), DipToPixel(parent, bounds.y),
      DipToPixel(parent, std::max(1.0, bounds.width)),
      DipToPixel(parent, std::max(1.0, bounds.height)), parent, nullptr,
      GetModuleHandleW(nullptr), wrapper);
  if (!wrapper->child || !InitializeWgl(wrapper)) {
    DestroySurface(wrapper);
    delete wrapper;
    return nullptr;
  }
  wrapper->config = ghostty_config_new();
  if (!wrapper->config) {
    DestroySurface(wrapper);
    delete wrapper;
    return nullptr;
  }
  ghostty_config_load_default_files(wrapper->config);
  ghostty_config_load_recursive_files(wrapper->config);
  ghostty_config_finalize(wrapper->config);
  ghostty_runtime_config_s runtime = {};
  runtime.userdata = wrapper;
  runtime.supports_selection_clipboard = false;
  runtime.wakeup_cb = Wakeup;
  runtime.action_cb = Action;
  runtime.read_clipboard_cb = ReadClipboard;
  runtime.confirm_read_clipboard_cb = ConfirmReadClipboard;
  runtime.write_clipboard_cb = WriteClipboard;
  runtime.close_surface_cb = CloseSurface;
  wrapper->app = ghostty_app_new(&runtime, wrapper->config);
  if (!wrapper->app || !CreateInnerSurface(wrapper)) {
    DestroySurface(wrapper);
    delete wrapper;
    return nullptr;
  }
  wrapper->closing.store(false, std::memory_order_release);
  SetWindowPos(wrapper->child, HWND_TOP, DipToPixel(parent, bounds.x),
               DipToPixel(parent, bounds.y),
               DipToPixel(parent, std::max(1.0, bounds.width)),
               DipToPixel(parent, std::max(1.0, bounds.height)),
               SWP_NOACTIVATE | (visible ? SWP_SHOWWINDOW : SWP_HIDEWINDOW));
  ghostty_app_set_focus(wrapper->app, focused);
  if (focused) SetFocus(wrapper->child);
  Trace("surface new: complete");
  return wrapper;
}

void soloe_ghostty_surface_free(SoloeGhosttySurface *wrapper) {
  if (!wrapper) return;
  DestroySurface(wrapper);
  delete wrapper;
}

bool soloe_ghostty_surface_write(SoloeGhosttySurface *wrapper,
                                 const uint8_t *bytes,
                                 size_t length) {
  TraceValue("surface write: entered", length);
  if (!wrapper || !wrapper->surface) return false;
  if (bytes && length > 0)
    ghostty_surface_process_output(wrapper->surface,
                                  reinterpret_cast<const char *>(bytes), length);
  Trace("surface write: complete");
  return wrapper->renderer_healthy.load(std::memory_order_acquire);
}

bool soloe_ghostty_surface_replace(SoloeGhosttySurface *wrapper,
                                   const uint8_t *bytes,
                                   size_t length) {
  TraceValue("surface replace: entered", length);
  if (!wrapper || !wrapper->surface) return false;
  ghostty_surface_free(wrapper->surface);
  Trace("surface replace: old surface freed");
  wrapper->surface = nullptr;
  if (!CreateInnerSurface(wrapper)) return false;
  Trace("surface replace: new surface created");
  return soloe_ghostty_surface_write(wrapper, bytes, length);
}

bool soloe_ghostty_surface_set_visible(SoloeGhosttySurface *wrapper,
                                       bool visible) {
  Trace("surface visible: entered");
  if (!wrapper || !wrapper->surface || !wrapper->child) return false;
  wrapper->visible = visible;
  ShowWindow(wrapper->child, visible ? SW_SHOWNA : SW_HIDE);
  ghostty_surface_set_occlusion(wrapper->surface, visible);
  Trace("surface visible: complete");
  return true;
}

bool soloe_ghostty_surface_set_focused(SoloeGhosttySurface *wrapper,
                                       bool focused) {
  Trace("surface focus: entered");
  if (!wrapper || !wrapper->surface) return false;
  wrapper->focused = focused;
  ghostty_app_set_focus(wrapper->app, focused);
  ghostty_surface_set_focus(wrapper->surface, focused);
  if (focused && wrapper->child) SetFocus(wrapper->child);
  Trace("surface focus: complete");
  return true;
}

bool soloe_ghostty_surface_set_bounds(SoloeGhosttySurface *wrapper,
                                      SoloeGhosttyBounds bounds,
                                      SoloeGhosttySize *size) {
  Trace("surface bounds: entered");
  if (!wrapper || !wrapper->surface || !wrapper->child || !size) return false;
  wrapper->bounds = bounds;
  if (!SetWindowPos(wrapper->child, HWND_TOP,
                    DipToPixel(wrapper->parent, bounds.x),
                    DipToPixel(wrapper->parent, bounds.y),
                    DipToPixel(wrapper->parent, std::max(1.0, bounds.width)),
                    DipToPixel(wrapper->parent, std::max(1.0, bounds.height)),
                    SWP_NOACTIVATE))
    return false;
  UpdateSurfaceMetrics(wrapper);
  const ghostty_surface_size_s native_size = ghostty_surface_size(wrapper->surface);
  size->columns = native_size.columns;
  size->rows = native_size.rows;
  Trace("surface bounds: complete");
  return true;
}

bool soloe_ghostty_surface_set_configuration(
    SoloeGhosttySurface *wrapper,
    SoloeGhosttyConfiguration configuration) {
  Trace("surface configuration: entered");
  if (!wrapper || !wrapper->surface ||
      !AssignConfiguration(wrapper, configuration))
    return false;
  ghostty_config_t config = SurfaceConfig(wrapper->configuration);
  if (!config) return false;
  ghostty_surface_update_config(wrapper->surface, config);
  ghostty_config_free(config);
  Trace("surface configuration: complete");
  return true;
}

bool soloe_ghostty_surface_paste(SoloeGhosttySurface *wrapper,
                                 const uint8_t *bytes,
                                 size_t length) {
  if (!wrapper || !wrapper->surface) return false;
  ghostty_surface_text(wrapper->surface,
                      reinterpret_cast<const char *>(bytes), length);
  return true;
}

bool soloe_ghostty_surface_clear_selection(SoloeGhosttySurface *wrapper) {
  if (!wrapper || !wrapper->surface) return false;
  ghostty_surface_clear_selection(wrapper->surface);
  EmitSelection(wrapper);
  return true;
}

char *soloe_ghostty_surface_export(SoloeGhosttySurface *wrapper, size_t *length) {
  if (!wrapper || !wrapper->surface || !length) return nullptr;
  ghostty_surface_scrollbar_s scrollbar = {};
  if (!ghostty_surface_scrollbar(wrapper->surface, &scrollbar)) return nullptr;
  ghostty_selection_s selection = {};
  selection.top_left.tag = GHOSTTY_POINT_SCREEN;
  selection.top_left.coord = GHOSTTY_POINT_COORD_TOP_LEFT;
  selection.top_left.x = 0;
  selection.top_left.y = 0;
  selection.bottom_right.tag = GHOSTTY_POINT_SCREEN;
  selection.bottom_right.coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT;
  selection.bottom_right.x = UINT32_MAX;
  selection.bottom_right.y =
      scrollbar.total == 0
          ? 0
          : static_cast<uint32_t>(std::min<uint64_t>(scrollbar.total - 1,
                                                     UINT32_MAX));
  selection.rectangle = false;
  ghostty_text_s text = {};
  if (!ghostty_surface_read_text(wrapper->surface, selection, &text)) return nullptr;
  char *copy = static_cast<char *>(malloc(text.text_len + 1));
  if (copy) {
    std::memcpy(copy, text.text, text.text_len);
    copy[text.text_len] = '\0';
    *length = text.text_len;
  }
  ghostty_surface_free_text(wrapper->surface, &text);
  return copy;
}

void soloe_ghostty_surface_free_export(char *text) { free(text); }

bool soloe_ghostty_surface_find(SoloeGhosttySurface *wrapper,
                                const char *query,
                                size_t query_length) {
  if (!wrapper || !query || query_length == 0) return false;
  size_t text_length = 0;
  char *text = soloe_ghostty_surface_export(wrapper, &text_length);
  if (!text || text_length < query_length) {
    free(text);
    return false;
  }
  bool found = false;
  for (size_t index = 0; index + query_length <= text_length; ++index) {
    if (std::memcmp(text + index, query, query_length) == 0) {
      found = true;
      break;
    }
  }
  free(text);
  return found;
}

bool soloe_ghostty_surface_scroll_to_bottom(SoloeGhosttySurface *wrapper) {
  if (!wrapper || !wrapper->surface) return false;
  ghostty_surface_scrollbar_s scrollbar = {};
  if (!ghostty_surface_scrollbar(wrapper->surface, &scrollbar)) return false;
  const uint64_t row = scrollbar.total > scrollbar.len
                           ? scrollbar.total - scrollbar.len
                           : 0;
  return ghostty_surface_scroll_to_row_if_revision(
      wrapper->surface, row, scrollbar.row_space_revision, &scrollbar);
}

}  // extern "C"
