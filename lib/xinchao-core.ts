import { kvGet, kvSet, registerKvMigration } from './kv-db';
import { loadCharacters } from './character-storage';
import type { Character } from './character-types';
import type { InnerBinding } from './xinchao-inner-types';
const KEY = 'float_xinchao_core_binding_v1';
registerKvMigration(KEY);
export type InnerPreferences = { binding: InnerBinding | null; tools: boolean; bodyInChat: boolean };
export function innerPreferences(): InnerPreferences {
    try {
        const v = JSON.parse(kvGet(KEY) || 'null');
        if (
            v &&
            typeof v.tools === 'boolean' &&
            typeof v.bodyInChat === 'boolean' &&
            (v.binding === null ||
                (typeof v.binding?.characterId === 'string' &&
                    typeof v.binding.name === 'string' &&
                    /^[a-f0-9]{64}$/.test(v.binding.coreHash)))
        )
            return { binding: v.binding, tools: v.tools, bodyInChat: v.bodyInChat };
    } catch {
        /* No authority from malformed settings. */
    }
    return { binding: null, tools: false, bodyInChat: false };
}
export function setInnerPreferences(next: InnerPreferences) {
    kvSet(KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('xinchao-core-updated'));
}
export async function characterCoreHash(character: Character) {
    // Stable authority is the actual card; dynamic emotion/scores are absent.
    const bytes = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
            JSON.stringify([
                character.id,
                character.name,
                character.persona,
                character.personality || '',
                character.briefPersona || '',
            ]),
        ),
    );
    return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
export async function fixedCoreMatches(characterId: string) {
    const binding = innerPreferences().binding;
    if (!binding) return true;
    const char = loadCharacters().find((c) => c.id === characterId);
    return !!(
        char &&
        binding.characterId === characterId &&
        binding.coreHash === (await characterCoreHash(char))
    );
}
