#import "ghostty_surface_bridge.h"

#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <CoreGraphics/CoreGraphics.h>
#import <QuartzCore/CAMetalLayer.h>
#import <dispatch/dispatch.h>
#import <ghostty.h>

#include <stdlib.h>
#include <string.h>

struct SoloeGhosttyHost {
  ghostty_app_t app;
  ghostty_config_t config;
};

struct SoloeGhosttySurface {
  SoloeGhosttyHost *host;
  ghostty_surface_t surface;
  NSView *parent;
  NSView *view;
  SoloeGhosttyBounds bounds;
  SoloeGhosttyConfiguration configuration;
  char *font_family;
  char *background;
  char *foreground;
  bool visible;
  bool focused;
  void *event_userdata;
  soloe_ghostty_bytes_cb input_cb;
  soloe_ghostty_text_cb selection_cb;
  soloe_ghostty_text_cb link_cb;
};

@interface SoloeGhosttyView : NSView {
 @private
  SoloeGhosttySurface *_owner;
  NSTrackingArea *_trackingArea;
}
- (instancetype)initWithFrame:(NSRect)frame owner:(SoloeGhosttySurface *)owner;
@end

static NSRect soloe_frame(NSView *parent, SoloeGhosttyBounds bounds) {
  CGFloat width = MAX(1.0, bounds.width);
  CGFloat height = MAX(1.0, bounds.height);
  CGFloat y = parent.isFlipped
                  ? bounds.y
                  : NSHeight(parent.bounds) - bounds.y - height;
  return NSMakeRect(bounds.x, y, width, height);
}

static ghostty_input_mods_e soloe_modifiers(NSEventModifierFlags flags) {
  int modifiers = GHOSTTY_MODS_NONE;
  if ((flags & NSEventModifierFlagShift) != 0) modifiers |= GHOSTTY_MODS_SHIFT;
  if ((flags & NSEventModifierFlagControl) != 0) modifiers |= GHOSTTY_MODS_CTRL;
  if ((flags & NSEventModifierFlagOption) != 0) modifiers |= GHOSTTY_MODS_ALT;
  if ((flags & NSEventModifierFlagCommand) != 0) modifiers |= GHOSTTY_MODS_SUPER;
  if ((flags & NSEventModifierFlagCapsLock) != 0) modifiers |= GHOSTTY_MODS_CAPS;
  if ((flags & NSEventModifierFlagNumericPad) != 0) modifiers |= GHOSTTY_MODS_NUM;
  return (ghostty_input_mods_e)modifiers;
}

static uint32_t soloe_first_codepoint(NSString *text) {
  if (text.length == 0) return 0;
  unichar first = [text characterAtIndex:0];
  if (CFStringIsSurrogateHighCharacter(first) && text.length > 1) {
    unichar second = [text characterAtIndex:1];
    if (CFStringIsSurrogateLowCharacter(second)) {
      return (uint32_t)CFStringGetLongCharacterForSurrogatePair(first, second);
    }
  }
  return first;
}

static void soloe_emit_selection(SoloeGhosttySurface *wrapper) {
  if (wrapper == NULL || wrapper->surface == NULL || wrapper->selection_cb == NULL) return;
  ghostty_text_s text = {0};
  if (!ghostty_surface_read_selection_clipboard_text(
          wrapper->surface, 16 * 1024 * 1024, &text)) {
    wrapper->selection_cb(wrapper->event_userdata, "", 0);
    return;
  }
  wrapper->selection_cb(wrapper->event_userdata, text.text, text.text_len);
  ghostty_surface_free_text(wrapper->surface, &text);
}

static void soloe_mouse_position(SoloeGhosttySurface *wrapper, NSEvent *event) {
  if (wrapper == NULL || wrapper->surface == NULL) return;
  NSPoint point = [wrapper->view convertPoint:event.locationInWindow fromView:nil];
  ghostty_surface_mouse_pos(wrapper->surface,
                            point.x,
                            point.y,
                            soloe_modifiers(event.modifierFlags));
}

static ghostty_input_mouse_button_e soloe_mouse_button(NSEvent *event) {
  switch (event.buttonNumber) {
    case 0: return GHOSTTY_MOUSE_LEFT;
    case 1: return GHOSTTY_MOUSE_RIGHT;
    case 2: return GHOSTTY_MOUSE_MIDDLE;
    case 3: return GHOSTTY_MOUSE_FOUR;
    case 4: return GHOSTTY_MOUSE_FIVE;
    default: return GHOSTTY_MOUSE_UNKNOWN;
  }
}

@implementation SoloeGhosttyView

- (instancetype)initWithFrame:(NSRect)frame owner:(SoloeGhosttySurface *)owner {
  self = [super initWithFrame:frame];
  if (self != nil) {
    _owner = owner;
    self.wantsLayer = YES;
  }
  return self;
}

- (CALayer *)makeBackingLayer {
  return [CAMetalLayer layer];
}

- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { (void)event; return YES; }

- (void)updateTrackingAreas {
  if (_trackingArea != nil) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:NSTrackingActiveInKeyWindow |
                   NSTrackingMouseMoved |
                   NSTrackingMouseEnteredAndExited |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [_trackingArea release];
  [super updateTrackingAreas];
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  if (_owner == NULL || _owner->surface == NULL || self.window == nil) return;
  CGFloat scale = self.window.backingScaleFactor;
  ghostty_surface_set_content_scale(_owner->surface, scale, scale);
  NSNumber *screenNumber = self.window.screen.deviceDescription[@"NSScreenNumber"];
  if (screenNumber != nil) {
    ghostty_surface_set_display_id(_owner->surface, screenNumber.unsignedIntValue);
  }
}

- (void)keyDown:(NSEvent *)event {
  if (_owner == NULL || _owner->surface == NULL) {
    [super keyDown:event];
    return;
  }
  NSString *characters = event.characters ?: @"";
  NSString *unshifted = event.charactersIgnoringModifiers ?: @"";
  const char *utf8 = characters.UTF8String;
  ghostty_input_key_s key = {0};
  key.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  key.mods = soloe_modifiers(event.modifierFlags);
  key.consumed_mods = GHOSTTY_MODS_NONE;
  key.keycode = event.keyCode;
  key.text = utf8;
  key.unshifted_codepoint = soloe_first_codepoint(unshifted);
  key.composing = false;
  if (!ghostty_surface_key(_owner->surface, key)) [super keyDown:event];
}

- (void)keyUp:(NSEvent *)event {
  if (_owner == NULL || _owner->surface == NULL) {
    [super keyUp:event];
    return;
  }
  NSString *characters = event.characters ?: @"";
  ghostty_input_key_s key = {0};
  key.action = GHOSTTY_ACTION_RELEASE;
  key.mods = soloe_modifiers(event.modifierFlags);
  key.consumed_mods = GHOSTTY_MODS_NONE;
  key.keycode = event.keyCode;
  key.text = characters.UTF8String;
  key.unshifted_codepoint = soloe_first_codepoint(event.charactersIgnoringModifiers ?: @"");
  key.composing = false;
  (void)ghostty_surface_key(_owner->surface, key);
}

- (void)mouseDown:(NSEvent *)event {
  soloe_mouse_position(_owner, event);
  ghostty_surface_mouse_button(_owner->surface,
                               GHOSTTY_MOUSE_PRESS,
                               soloe_mouse_button(event),
                               soloe_modifiers(event.modifierFlags));
}

- (void)mouseUp:(NSEvent *)event {
  soloe_mouse_position(_owner, event);
  ghostty_surface_mouse_button(_owner->surface,
                               GHOSTTY_MOUSE_RELEASE,
                               soloe_mouse_button(event),
                               soloe_modifiers(event.modifierFlags));
  soloe_emit_selection(_owner);
}

- (void)rightMouseDown:(NSEvent *)event { [self mouseDown:event]; }
- (void)rightMouseUp:(NSEvent *)event { [self mouseUp:event]; }
- (void)otherMouseDown:(NSEvent *)event { [self mouseDown:event]; }
- (void)otherMouseUp:(NSEvent *)event { [self mouseUp:event]; }
- (void)mouseMoved:(NSEvent *)event { soloe_mouse_position(_owner, event); }
- (void)mouseDragged:(NSEvent *)event { soloe_mouse_position(_owner, event); }
- (void)rightMouseDragged:(NSEvent *)event { soloe_mouse_position(_owner, event); }
- (void)otherMouseDragged:(NSEvent *)event { soloe_mouse_position(_owner, event); }

- (void)scrollWheel:(NSEvent *)event {
  soloe_mouse_position(_owner, event);
  ghostty_surface_mouse_scroll(_owner->surface,
                               event.scrollingDeltaX,
                               event.scrollingDeltaY,
                               0);
}

@end

static void soloe_tick(void *userdata) {
  SoloeGhosttyHost *host = userdata;
  if (host != NULL && host->app != NULL) ghostty_app_tick(host->app);
}

static void soloe_wakeup(void *userdata) {
  dispatch_async_f(dispatch_get_main_queue(), userdata, soloe_tick);
}

static bool soloe_action(ghostty_app_t app,
                         ghostty_target_s target,
                         ghostty_action_s action) {
  (void)app;
  if (target.tag != GHOSTTY_TARGET_SURFACE || target.target.surface == NULL) return false;
  SoloeGhosttySurface *wrapper = ghostty_surface_userdata(target.target.surface);
  if (wrapper == NULL) return false;
  if (action.tag == GHOSTTY_ACTION_SELECTION_CHANGED) {
    soloe_emit_selection(wrapper);
    return true;
  }
  if (action.tag == GHOSTTY_ACTION_OPEN_URL && wrapper->link_cb != NULL) {
    ghostty_action_open_url_s value = action.action.open_url;
    wrapper->link_cb(wrapper->event_userdata, value.url, value.len);
    return true;
  }
  return false;
}

static bool soloe_read_clipboard(void *userdata,
                                 ghostty_clipboard_e clipboard,
                                 void *request) {
  (void)clipboard;
  SoloeGhosttySurface *wrapper = userdata;
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  NSString *value = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString] ?: @"";
  ghostty_surface_complete_clipboard_request(wrapper->surface,
                                             value.UTF8String,
                                             request,
                                             false);
  return true;
}

static void soloe_confirm_read_clipboard(void *userdata,
                                         const char *value,
                                         void *request,
                                         ghostty_clipboard_request_e request_type) {
  (void)request_type;
  SoloeGhosttySurface *wrapper = userdata;
  if (wrapper != NULL && wrapper->surface != NULL) {
    ghostty_surface_complete_clipboard_request(wrapper->surface, value, request, false);
  }
}

static void soloe_write_clipboard(void *userdata,
                                  ghostty_clipboard_e clipboard,
                                  const ghostty_clipboard_content_s *content,
                                  size_t count,
                                  bool confirm) {
  (void)userdata;
  (void)clipboard;
  (void)confirm;
  for (size_t index = 0; index < count; index += 1) {
    if (content[index].mime == NULL || content[index].data == NULL) continue;
    NSString *mime = [NSString stringWithUTF8String:content[index].mime];
    if (![mime containsString:@"text/plain"]) continue;
    NSString *value = [NSString stringWithUTF8String:content[index].data];
    if (value == nil) continue;
    NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
    [pasteboard clearContents];
    [pasteboard setString:value forType:NSPasteboardTypeString];
    return;
  }
}

static void soloe_close_surface(void *userdata, bool process_alive) {
  (void)process_alive;
  SoloeGhosttySurface *wrapper = userdata;
  if (wrapper != NULL && wrapper->surface != NULL) {
    ghostty_surface_set_occlusion(wrapper->surface, false);
  }
}

static void soloe_io_write(void *userdata, const char *bytes, uintptr_t len) {
  SoloeGhosttySurface *wrapper = userdata;
  if (wrapper != NULL && wrapper->input_cb != NULL && bytes != NULL && len > 0) {
    wrapper->input_cb(wrapper->event_userdata, (const uint8_t *)bytes, len);
  }
}

static NSString *soloe_safe_config_value(const char *value) {
  NSString *result = value == NULL ? @"" : [NSString stringWithUTF8String:value];
  return [result stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
}

static ghostty_config_t soloe_surface_config(SoloeGhosttyConfiguration configuration) {
  ghostty_config_t config = ghostty_config_new();
  if (config == NULL) return NULL;
  ghostty_config_load_default_files(config);
  ghostty_config_load_recursive_files(config);
  NSString *source = [NSString stringWithFormat:
      @"font-family = %@\nfont-size = %.3f\nbackground = %@\nforeground = %@\n",
      soloe_safe_config_value(configuration.font_family),
      MAX(6.0, configuration.font_size),
      soloe_safe_config_value(configuration.background),
      soloe_safe_config_value(configuration.foreground)];
  const char *bytes = source.UTF8String;
  ghostty_config_load_string(config, bytes, strlen(bytes), "soloe-terminal-presentation");
  ghostty_config_finalize(config);
  return config;
}

static bool soloe_assign_configuration(
    SoloeGhosttySurface *wrapper,
    SoloeGhosttyConfiguration configuration) {
  char *font_family = strdup(configuration.font_family == NULL
                                 ? ""
                                 : configuration.font_family);
  char *background = strdup(configuration.background == NULL
                                ? ""
                                : configuration.background);
  char *foreground = strdup(configuration.foreground == NULL
                                ? ""
                                : configuration.foreground);
  if (font_family == NULL || background == NULL || foreground == NULL) {
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

static bool soloe_create_inner_surface(SoloeGhosttySurface *wrapper) {
  ghostty_surface_config_s options = ghostty_surface_config_new();
  options.platform_tag = GHOSTTY_PLATFORM_MACOS;
  options.platform.macos.nsview = wrapper->view;
  options.userdata = wrapper;
  options.scale_factor = wrapper->view.window.backingScaleFactor ?: 1.0;
  options.font_size = (float)MAX(6.0, wrapper->configuration.font_size);
  options.working_directory = NULL;
  options.command = NULL;
  options.env_vars = NULL;
  options.env_var_count = 0;
  options.initial_input = NULL;
  options.wait_after_command = false;
  options.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;
  options.io_mode = GHOSTTY_SURFACE_IO_MANUAL;
  options.io_write_cb = soloe_io_write;
  options.io_write_userdata = wrapper;
  size_t scrollback_limit = wrapper->configuration.scrollback > SIZE_MAX / 1024
                                ? SIZE_MAX
                                : wrapper->configuration.scrollback * 1024;
  wrapper->surface = ghostty_surface_new_with_scrollback_limit(
      wrapper->host->app, &options, scrollback_limit);
  if (wrapper->surface == NULL) return false;

  ghostty_config_t config = soloe_surface_config(wrapper->configuration);
  if (config != NULL) {
    ghostty_surface_update_config(wrapper->surface, config);
    ghostty_config_free(config);
  }
  NSRect backing = [wrapper->view convertRectToBacking:wrapper->view.bounds];
  ghostty_surface_set_size(wrapper->surface,
                           (uint32_t)MAX(1.0, NSWidth(backing)),
                           (uint32_t)MAX(1.0, NSHeight(backing)));
  ghostty_surface_set_occlusion(wrapper->surface, wrapper->visible);
  ghostty_surface_set_focus(wrapper->surface, wrapper->focused);
  (void)ghostty_surface_set_renderer_realized(wrapper->surface, true);
  return true;
}

static void soloe_initialize_once(void *userdata) {
  int *result = userdata;
  *result = ghostty_init(0, NULL);
}

SoloeGhosttyHost *soloe_ghostty_host_new(void) {
  static dispatch_once_t once;
  static int init_result = -1;
  dispatch_once_f(&once, &init_result, (dispatch_function_t)soloe_initialize_once);
  if (init_result != GHOSTTY_SUCCESS) return NULL;

  SoloeGhosttyHost *host = calloc(1, sizeof(SoloeGhosttyHost));
  if (host == NULL) return NULL;
  host->config = ghostty_config_new();
  if (host->config == NULL) {
    free(host);
    return NULL;
  }
  ghostty_config_load_default_files(host->config);
  ghostty_config_load_recursive_files(host->config);
  ghostty_config_finalize(host->config);

  ghostty_runtime_config_s runtime = {0};
  runtime.userdata = host;
  runtime.supports_selection_clipboard = false;
  runtime.wakeup_cb = soloe_wakeup;
  runtime.action_cb = soloe_action;
  runtime.read_clipboard_cb = soloe_read_clipboard;
  runtime.confirm_read_clipboard_cb = soloe_confirm_read_clipboard;
  runtime.write_clipboard_cb = soloe_write_clipboard;
  runtime.close_surface_cb = soloe_close_surface;
  host->app = ghostty_app_new(&runtime, host->config);
  if (host->app == NULL) {
    ghostty_config_free(host->config);
    free(host);
    return NULL;
  }
  return host;
}

void soloe_ghostty_host_free(SoloeGhosttyHost *host) {
  if (host == NULL) return;
  if (host->app != NULL) ghostty_app_free(host->app);
  if (host->config != NULL) ghostty_config_free(host->config);
  free(host);
}

SoloeGhosttySurface *soloe_ghostty_surface_new(
    SoloeGhosttyHost *host,
    void *parent_nsview,
    SoloeGhosttyBounds bounds,
    SoloeGhosttyConfiguration configuration,
    bool visible,
    bool focused,
    void *event_userdata,
    soloe_ghostty_bytes_cb input_cb,
    soloe_ghostty_text_cb selection_cb,
    soloe_ghostty_text_cb link_cb) {
  if (host == NULL || parent_nsview == NULL) return NULL;
  SoloeGhosttySurface *wrapper = calloc(1, sizeof(SoloeGhosttySurface));
  if (wrapper == NULL) return NULL;
  wrapper->host = host;
  wrapper->parent = (NSView *)parent_nsview;
  wrapper->bounds = bounds;
  if (!soloe_assign_configuration(wrapper, configuration)) {
    free(wrapper);
    return NULL;
  }
  wrapper->visible = visible;
  wrapper->focused = focused;
  wrapper->event_userdata = event_userdata;
  wrapper->input_cb = input_cb;
  wrapper->selection_cb = selection_cb;
  wrapper->link_cb = link_cb;
  wrapper->view = [[SoloeGhosttyView alloc]
      initWithFrame:soloe_frame(wrapper->parent, bounds)
              owner:wrapper];
  [wrapper->parent addSubview:wrapper->view positioned:NSWindowAbove relativeTo:nil];
  wrapper->view.hidden = !visible;
  if (!soloe_create_inner_surface(wrapper)) {
    [wrapper->view removeFromSuperview];
    [wrapper->view release];
    free(wrapper->font_family);
    free(wrapper->background);
    free(wrapper->foreground);
    free(wrapper);
    return NULL;
  }
  if (focused) [wrapper->view.window makeFirstResponder:wrapper->view];
  return wrapper;
}

void soloe_ghostty_surface_free(SoloeGhosttySurface *wrapper) {
  if (wrapper == NULL) return;
  if (wrapper->surface != NULL) {
    (void)ghostty_surface_set_renderer_realized(wrapper->surface, false);
    ghostty_surface_free(wrapper->surface);
    wrapper->surface = NULL;
  }
  [wrapper->view removeFromSuperview];
  [wrapper->view release];
  free(wrapper->font_family);
  free(wrapper->background);
  free(wrapper->foreground);
  free(wrapper);
}

bool soloe_ghostty_surface_write(SoloeGhosttySurface *wrapper,
                                 const uint8_t *bytes,
                                 size_t len) {
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  if (bytes != NULL && len > 0) {
    ghostty_surface_process_output(wrapper->surface, (const char *)bytes, len);
  }
  return true;
}

bool soloe_ghostty_surface_replace(SoloeGhosttySurface *wrapper,
                                   const uint8_t *bytes,
                                   size_t len) {
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  (void)ghostty_surface_set_renderer_realized(wrapper->surface, false);
  ghostty_surface_free(wrapper->surface);
  wrapper->surface = NULL;
  if (!soloe_create_inner_surface(wrapper)) return false;
  return soloe_ghostty_surface_write(wrapper, bytes, len);
}

bool soloe_ghostty_surface_set_visible(SoloeGhosttySurface *wrapper, bool visible) {
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  wrapper->visible = visible;
  wrapper->view.hidden = !visible;
  ghostty_surface_set_occlusion(wrapper->surface, visible);
  return true;
}

bool soloe_ghostty_surface_set_focused(SoloeGhosttySurface *wrapper, bool focused) {
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  wrapper->focused = focused;
  ghostty_surface_set_focus(wrapper->surface, focused);
  if (focused) [wrapper->view.window makeFirstResponder:wrapper->view];
  return true;
}

bool soloe_ghostty_surface_set_bounds(SoloeGhosttySurface *wrapper,
                                      SoloeGhosttyBounds bounds,
                                      SoloeGhosttySize *size) {
  if (wrapper == NULL || wrapper->surface == NULL || size == NULL) return false;
  wrapper->bounds = bounds;
  wrapper->view.frame = soloe_frame(wrapper->parent, bounds);
  NSRect backing = [wrapper->view convertRectToBacking:wrapper->view.bounds];
  ghostty_surface_set_size(wrapper->surface,
                           (uint32_t)MAX(1.0, NSWidth(backing)),
                           (uint32_t)MAX(1.0, NSHeight(backing)));
  ghostty_surface_size_s native_size = ghostty_surface_size(wrapper->surface);
  size->columns = native_size.columns;
  size->rows = native_size.rows;
  return true;
}

bool soloe_ghostty_surface_set_configuration(
    SoloeGhosttySurface *wrapper,
    SoloeGhosttyConfiguration configuration) {
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  if (!soloe_assign_configuration(wrapper, configuration)) return false;
  ghostty_config_t config = soloe_surface_config(wrapper->configuration);
  if (config == NULL) return false;
  ghostty_surface_update_config(wrapper->surface, config);
  ghostty_config_free(config);
  return true;
}

bool soloe_ghostty_surface_paste(SoloeGhosttySurface *wrapper,
                                 const uint8_t *bytes,
                                 size_t len) {
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  ghostty_surface_text(wrapper->surface, (const char *)bytes, len);
  return true;
}

bool soloe_ghostty_surface_clear_selection(SoloeGhosttySurface *wrapper) {
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  (void)ghostty_surface_clear_selection(wrapper->surface);
  soloe_emit_selection(wrapper);
  return true;
}

char *soloe_ghostty_surface_export(SoloeGhosttySurface *wrapper, size_t *len) {
  if (wrapper == NULL || wrapper->surface == NULL || len == NULL) return NULL;
  ghostty_surface_scrollbar_s scrollbar = {0};
  if (!ghostty_surface_scrollbar(wrapper->surface, &scrollbar)) return NULL;
  ghostty_selection_s selection = {0};
  selection.top_left.tag = GHOSTTY_POINT_SCREEN;
  selection.top_left.coord = GHOSTTY_POINT_COORD_TOP_LEFT;
  selection.top_left.x = 0;
  selection.top_left.y = 0;
  selection.bottom_right.tag = GHOSTTY_POINT_SCREEN;
  selection.bottom_right.coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT;
  selection.bottom_right.x = UINT32_MAX;
  selection.bottom_right.y = scrollbar.total == 0
                                 ? 0
                                 : (uint32_t)MIN(scrollbar.total - 1, UINT32_MAX);
  selection.rectangle = false;
  ghostty_text_s text = {0};
  if (!ghostty_surface_read_text(wrapper->surface, selection, &text)) return NULL;
  char *copy = malloc(text.text_len + 1);
  if (copy != NULL) {
    memcpy(copy, text.text, text.text_len);
    copy[text.text_len] = '\0';
    *len = text.text_len;
  }
  ghostty_surface_free_text(wrapper->surface, &text);
  return copy;
}

void soloe_ghostty_surface_free_export(char *text) { free(text); }

bool soloe_ghostty_surface_find(SoloeGhosttySurface *wrapper,
                                const char *query,
                                size_t query_len) {
  if (wrapper == NULL || query == NULL || query_len == 0) return false;
  size_t text_len = 0;
  char *text = soloe_ghostty_surface_export(wrapper, &text_len);
  if (text == NULL || text_len < query_len) {
    free(text);
    return false;
  }
  bool found = false;
  for (size_t index = 0; index + query_len <= text_len; index += 1) {
    if (memcmp(text + index, query, query_len) == 0) {
      found = true;
      break;
    }
  }
  free(text);
  return found;
}

bool soloe_ghostty_surface_scroll_to_bottom(SoloeGhosttySurface *wrapper) {
  if (wrapper == NULL || wrapper->surface == NULL) return false;
  ghostty_surface_scrollbar_s scrollbar = {0};
  if (!ghostty_surface_scrollbar(wrapper->surface, &scrollbar)) return false;
  uint64_t row = scrollbar.total > scrollbar.len
                     ? scrollbar.total - scrollbar.len
                     : 0;
  return ghostty_surface_scroll_to_row_if_revision(
      wrapper->surface, row, scrollbar.row_space_revision, &scrollbar);
}
