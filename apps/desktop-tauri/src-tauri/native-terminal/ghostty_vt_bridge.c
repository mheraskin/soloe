#include "ghostty_vt_bridge.h"

#include <ghostty/vt.h>
#include <stdlib.h>

struct SoloeGhosttyTerminal {
  GhosttyTerminal terminal;
  GhosttyFormatter formatter;
};

SoloeGhosttyTerminal *soloe_ghostty_terminal_new(uint16_t cols, uint16_t rows) {
  SoloeGhosttyTerminal *bridge = calloc(1, sizeof(SoloeGhosttyTerminal));
  if (bridge == NULL) return NULL;

  if (ghostty_terminal_new(NULL, &bridge->terminal, cols, rows) !=
      GHOSTTY_SUCCESS) {
    free(bridge);
    return NULL;
  }

  GhosttyFormatterTerminalOptions options =
      GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  options.trim = false;
  if (ghostty_formatter_terminal_new(
          NULL, &bridge->formatter, bridge->terminal, options) !=
      GHOSTTY_SUCCESS) {
    ghostty_terminal_free(bridge->terminal);
    free(bridge);
    return NULL;
  }

  return bridge;
}

void soloe_ghostty_terminal_free(SoloeGhosttyTerminal *bridge) {
  if (bridge == NULL) return;
  ghostty_formatter_free(bridge->formatter);
  ghostty_terminal_free(bridge->terminal);
  free(bridge);
}

void soloe_ghostty_terminal_write(
    SoloeGhosttyTerminal *bridge,
    const uint8_t *data,
    size_t len) {
  if (bridge == NULL || data == NULL || len == 0) return;
  ghostty_terminal_vt_write(bridge->terminal, data, len);
}

void soloe_ghostty_terminal_replace(
    SoloeGhosttyTerminal *bridge,
    const uint8_t *data,
    size_t len) {
  if (bridge == NULL) return;
  ghostty_terminal_reset(bridge->terminal);
  soloe_ghostty_terminal_write(bridge, data, len);
}

bool soloe_ghostty_terminal_resize(
    SoloeGhosttyTerminal *bridge,
    uint16_t cols,
    uint16_t rows,
    uint32_t cell_width_px,
    uint32_t cell_height_px) {
  if (bridge == NULL) return false;
  return ghostty_terminal_resize(
             bridge->terminal,
             cols,
             rows,
             cell_width_px,
             cell_height_px) == GHOSTTY_SUCCESS;
}

bool soloe_ghostty_terminal_export(
    SoloeGhosttyTerminal *bridge,
    uint8_t **data,
    size_t *len) {
  if (bridge == NULL || data == NULL || len == NULL) return false;
  *data = NULL;
  *len = 0;
  return ghostty_formatter_format_alloc(
             bridge->formatter, NULL, data, len) == GHOSTTY_SUCCESS;
}

void soloe_ghostty_terminal_free_export(uint8_t *data, size_t len) {
  if (data != NULL) ghostty_free(NULL, data, len);
}
