import { MAX_ALLOWED_MACROS, type Macro } from 'uhk-common';

export function generateMacroId(macros: Macro[]): number {
    let newId = 0;
    const usedMacroIds = new Set();

    macros.forEach((macro: Macro) => {
        if (macro.id > newId) {
            newId = macro.id;
        }

        usedMacroIds.add(macro.id);
    });

    newId += 1;

    if (newId <= MAX_ALLOWED_MACROS)
        return newId;

    for (let i = 0; i <= MAX_ALLOWED_MACROS; i++) {
        if (!usedMacroIds.has(i)) {
            return i;
        }
    }
}

export function insertItemInNameOrder<T extends { name: string }>(
    items: T[], newItem: T, keepItem: (item: T) => boolean = () => true
): T[] {
    const newItems: T[] = [];
    let added = false;
    for (const item of items) {
        if (!added && item.name.localeCompare(newItem.name) > 0) {
            newItems.push(newItem);
            added = true;
        }
        if (keepItem(item)) {
            newItems.push(item);
        }
    }
    if (!added) {
        newItems.push(newItem);
    }

    return newItems;
}
