import { bgSetInterval } from "./bg-timer";
import { loadCharacters } from "./character-storage";
import type { Character } from "./character-types";
import { generateDiaryEntryForCharacter } from "./diary-entry-engine";
import {
  createDiaryEntry,
  loadDiaryEntries,
  loadDiaryEntryTimerSettings,
  saveDiaryEntryTimerSettings,
} from "./diary-entry-storage";
import type { DiaryEntryTimerSettings } from "./diary-entry-types";

const CHECK_INTERVAL_MS = 60_000;

export const DIARY_ENTRIES_UPDATED_EVENT = "diary-entries-updated";
export const DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT = "diary-entry-timer-settings-updated";

let stopInterval: (() => void) | null = null;
let running = false;
let currentGeneration: AbortController | null = null;

function dispatchGlobalNotice(message: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("global-notice", { detail: message }));
}

function dispatchEntriesUpdated(createdCount: number, failedCount: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DIARY_ENTRIES_UPDATED_EVENT, {
    detail: { source: "timer", createdCount, failedCount },
  }));
}

function resolveTimerTargets(settings: DiaryEntryTimerSettings, characters: Character[]): Character[] {
  const scheduledIds = settings.characterIds.length > 0
    ? settings.characterIds
    : characters.map(character => character.id);
  const uniqueIds = Array.from(new Set(scheduledIds.filter(Boolean)));
  return uniqueIds
    .map(characterId => characters.find(character => character.id === characterId))
    .filter(Boolean) as Character[];
}

function getDueTargets(settings: DiaryEntryTimerSettings): Character[] {
  if (!settings.enabled) return [];
  const characters = loadCharacters();
  const targets = resolveTimerTargets(settings, characters);
  if (targets.length === 0) return [];

  const now = Date.now();
  const intervalMs = Math.max(1, settings.intervalHours) * 60 * 60 * 1000;
  return targets.filter(character => {
    const last = settings.lastRunAtByCharacter[character.id];
    const lastTime = last ? new Date(last).getTime() : 0;
    return !lastTime || now - lastTime >= intervalMs;
  });
}

function stampAttemptedCharacters(characterIds: string[], stamp: string): void {
  if (characterIds.length === 0) return;
  const latest = loadDiaryEntryTimerSettings();
  saveDiaryEntryTimerSettings({
    ...latest,
    lastRunAtByCharacter: {
      ...latest.lastRunAtByCharacter,
      ...Object.fromEntries(characterIds.map(characterId => [characterId, stamp])),
    },
  });
}

export async function runDiaryEntryTimerCheck(): Promise<void> {
  if (typeof window === "undefined" || running) return;

  const settings = loadDiaryEntryTimerSettings();
  const dueTargets = getDueTargets(settings);
  if (dueTargets.length === 0) return;

  running = true;
  const controller = new AbortController(); currentGeneration = controller;
  let createdCount = 0;
  const createdNames: string[] = [];
  const failedNames: string[] = [];

  try {
    for (const character of dueTargets) {
      // A switch change or stop must also fence the already captured batch.
      if (controller.signal.aborted || !getDueTargets(loadDiaryEntryTimerSettings()).some(target => target.id === character.id)) break;
      try {
        // Reserve before HTTP: closing/reloading during an unknown result must
        // not immediately request the same scheduled diary a second time.
        stampAttemptedCharacters([character.id], new Date().toISOString());
        const draft = await generateDiaryEntryForCharacter(character.id, loadDiaryEntries(), "timer", { signal: controller.signal });
        controller.signal.throwIfAborted();
        const latest = loadDiaryEntryTimerSettings();
        if (!latest.enabled || !resolveTimerTargets(latest, loadCharacters()).some(target => target.id === character.id)) break;
        createDiaryEntry({
          characterId: character.id,
          characterName: character.name,
          title: draft.title,
          mood: draft.mood,
          weather: draft.weather,
          tags: draft.tags,
          body: draft.body,
          blocks: draft.blocks,
          trigger: "timer",
        });
        createdCount += 1;
        createdNames.push(character.name);
      } catch {
        if (controller.signal.aborted) break;
        failedNames.push(character.name);
        console.warn("[DiaryEntryTimer] scheduled generation failed; request was not retried.");
      }
    }

    if (createdCount > 0 || failedNames.length > 0) {
      dispatchEntriesUpdated(createdCount, failedNames.length);
    }
    if (createdCount === 1 && failedNames.length === 0) {
      dispatchGlobalNotice(`${createdNames[0] ?? "角色"} 写了一篇日记。`);
    } else if (createdCount > 0) {
      dispatchGlobalNotice(`已生成 ${createdCount} 篇定时日记${failedNames.length ? `，${failedNames.length} 个失败` : ""}。`);
    } else if (failedNames.length > 0) {
      dispatchGlobalNotice(`定时日记生成失败：${failedNames.join("、")}`);
    }
  } finally {
    if (currentGeneration === controller) currentGeneration = null;
    running = false;
  }
}

function handleVisibilityChange(): void {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  void runDiaryEntryTimerCheck();
}

function handleSettingsUpdated(): void {
  currentGeneration?.abort();
  void runDiaryEntryTimerCheck();
}

export function startDiaryEntryTimerService(): void {
  if (typeof window === "undefined" || stopInterval) return;
  stopInterval = bgSetInterval(() => {
    void runDiaryEntryTimerCheck();
  }, CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener(DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
  void runDiaryEntryTimerCheck();
}

export function stopDiaryEntryTimerService(): void {
  currentGeneration?.abort();
  if (stopInterval) {
    stopInterval();
    stopInterval = null;
  }
  if (typeof window === "undefined") return;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener(DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
}
