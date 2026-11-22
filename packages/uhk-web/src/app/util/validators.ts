export function isValidName(name: string): boolean {
    return name && name.trim().length > 0;
}

/** Symbols the keyboard display can show in a keymap abbreviation from user configuration 4.2.0. */
export const KEYMAP_ABBREVIATION_SYMBOLS = '$+-*/|\\<>?_\'",`@={} ';

/** 1 to 3 letters or digits, plus the display symbols when the firmware supports them. */
export function keymapAbbreviationPattern({ extraLedCharacters, lowercase }: { extraLedCharacters: boolean; lowercase: boolean }): RegExp {
    const symbols = extraLedCharacters ? KEYMAP_ABBREVIATION_SYMBOLS.replace(/[\\\]^-]/g, '\\$&') : '';
    return new RegExp(`^[A-Z${lowercase ? 'a-z' : ''}\\d${symbols}]{1,3}$`);
}
