/**
 * Strips ASCII control characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F) from string inputs.
 * Preserves standard whitespace (0x09 tab, 0x0A newline, 0x0D carriage return).
 */
export function stripControlCharacters(input: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII control character stripping
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/**
 * Normalizes email: strips control characters, trims whitespace, and converts to lowercase.
 */
export function normalizeEmail(email: string): string {
  return stripControlCharacters(email).trim().toLowerCase();
}
