#ifndef SOLOE_GHOSTTY_VT_BRIDGE_H
#define SOLOE_GHOSTTY_VT_BRIDGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct SoloeGhosttyTerminal SoloeGhosttyTerminal;

SoloeGhosttyTerminal *soloe_ghostty_terminal_new(uint16_t cols, uint16_t rows);
void soloe_ghostty_terminal_free(SoloeGhosttyTerminal *terminal);
void soloe_ghostty_terminal_write(
    SoloeGhosttyTerminal *terminal,
    const uint8_t *data,
    size_t len);
void soloe_ghostty_terminal_replace(
    SoloeGhosttyTerminal *terminal,
    const uint8_t *data,
    size_t len);
bool soloe_ghostty_terminal_resize(
    SoloeGhosttyTerminal *terminal,
    uint16_t cols,
    uint16_t rows,
    uint32_t cell_width_px,
    uint32_t cell_height_px);
bool soloe_ghostty_terminal_export(
    SoloeGhosttyTerminal *terminal,
    uint8_t **data,
    size_t *len);
void soloe_ghostty_terminal_free_export(uint8_t *data, size_t len);

#endif
