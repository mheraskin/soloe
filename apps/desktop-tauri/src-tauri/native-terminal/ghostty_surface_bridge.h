#ifndef SOLOE_GHOSTTY_SURFACE_BRIDGE_H
#define SOLOE_GHOSTTY_SURFACE_BRIDGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct SoloeGhosttyHost SoloeGhosttyHost;
typedef struct SoloeGhosttySurface SoloeGhosttySurface;

typedef void (*soloe_ghostty_bytes_cb)(void *userdata,
                                       const uint8_t *bytes,
                                       size_t len);
typedef void (*soloe_ghostty_text_cb)(void *userdata,
                                      const char *text,
                                      size_t len);
typedef void (*soloe_ghostty_revision_cb)(void *userdata, uint64_t revision);

typedef struct {
  double x;
  double y;
  double width;
  double height;
} SoloeGhosttyBounds;

typedef struct {
  const char *font_family;
  double font_size;
  double line_height;
  const char *background;
  const char *foreground;
  size_t scrollback;
} SoloeGhosttyConfiguration;

typedef struct {
  uint16_t columns;
  uint16_t rows;
} SoloeGhosttySize;

SoloeGhosttyHost *soloe_ghostty_host_new(void);
void soloe_ghostty_host_free(SoloeGhosttyHost *host);

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
    soloe_ghostty_text_cb link_cb);

void soloe_ghostty_surface_free(SoloeGhosttySurface *surface);
bool soloe_ghostty_surface_write(SoloeGhosttySurface *surface,
                                 const uint8_t *bytes,
                                 size_t len);
bool soloe_ghostty_surface_replace(SoloeGhosttySurface *surface,
                                   const uint8_t *bytes,
                                   size_t len);
bool soloe_ghostty_surface_set_visible(SoloeGhosttySurface *surface,
                                       bool visible);
bool soloe_ghostty_surface_set_focused(SoloeGhosttySurface *surface,
                                       bool focused);
bool soloe_ghostty_surface_set_bounds(SoloeGhosttySurface *surface,
                                      SoloeGhosttyBounds bounds,
                                      SoloeGhosttySize *size);
bool soloe_ghostty_surface_set_configuration(
    SoloeGhosttySurface *surface,
    SoloeGhosttyConfiguration configuration);
bool soloe_ghostty_surface_paste(SoloeGhosttySurface *surface,
                                 const uint8_t *bytes,
                                 size_t len);
bool soloe_ghostty_surface_clear_selection(SoloeGhosttySurface *surface);
bool soloe_ghostty_surface_find(SoloeGhosttySurface *surface,
                                const char *query,
                                size_t len);
char *soloe_ghostty_surface_export(SoloeGhosttySurface *surface,
                                   size_t *len);
void soloe_ghostty_surface_free_export(char *text);
bool soloe_ghostty_surface_scroll_to_bottom(SoloeGhosttySurface *surface);

// Windows parses output on a presentation worker. These functions let the
// renderer keep the same ordered-write backpressure as xterm without blocking
// the Win32/WebView UI thread. Other platform bridges keep their synchronous
// write contract and do not export these symbols.
uint64_t soloe_ghostty_surface_write_async(SoloeGhosttySurface *surface,
                                           const uint8_t *bytes,
                                           size_t len);
uint64_t soloe_ghostty_surface_replace_async(SoloeGhosttySurface *surface,
                                             const uint8_t *bytes,
                                             size_t len);
void soloe_ghostty_surface_set_output_complete_callback(
    SoloeGhosttySurface *surface,
    soloe_ghostty_revision_cb callback);

#endif
