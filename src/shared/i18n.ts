import en from "./i18n/en.json";
import zhHant from "./i18n/zh-Hant.json";
import zhHans from "./i18n/zh-Hans.json";
import ja from "./i18n/ja.json";

export type Language = "en" | "zh-Hant" | "zh-Hans" | "ja";
export type LanguageSetting = "system" | Language;
type Catalog = Record<string, string>;
type Variables = Record<string, string | number>;

const catalogs: Record<Language, Catalog> = {
  en,
  "zh-Hant": zhHant,
  "zh-Hans": zhHans,
  ja,
};

let language: Language = "en";
const listeners = new Set<(language: Language) => void>();
const attributes = ["title", "aria-label", "placeholder", "alt"] as const;

export function getLanguage(): Language {
  return language;
}

export function resolveSystemLanguage(preferred: readonly string[] = navigator.languages): Language {
  for (const raw of preferred) {
    const parts = raw.replace(/_/g, "-").toLowerCase().split("-");
    if (parts[0] === "en") return "en";
    if (parts[0] === "ja") return "ja";
    if (parts[0] !== "zh") continue;
    const script = parts.slice(1).find((part) => part.length === 4);
    const region = parts.slice(1).find((part) => part.length === 2 || part.length === 3);
    if (script === "hant" || ["hk", "tw", "mo"].includes(region ?? "")) return "zh-Hant";
    if (script === "hans" || ["cn", "sg"].includes(region ?? "") || !region) return "zh-Hans";
  }
  return "en";
}

export function t(key: string, vars: Variables = {}): string {
  const english = en as Catalog;
  const template = catalogs[language][key] ?? english[key] ?? key;
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

function readVars(el: HTMLElement): Variables {
  if (!el.dataset.i18nVars) return {};
  try {
    const value: unknown = JSON.parse(el.dataset.i18nVars);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Variables : {};
  } catch {
    return {};
  }
}

export function applyTranslations(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>(
    "[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder], [data-i18n-alt]",
  )) {
    const vars = readVars(el);
    if (el.dataset.i18n) el.textContent = t(el.dataset.i18n, vars);
    for (const attr of attributes) {
      const key = el.dataset[datasetKey(attr)];
      if (key) el.setAttribute(attr, t(key, vars));
    }
  }
}

export function setI18nText(el: HTMLElement, key: string, vars?: Variables): void {
  el.dataset.i18n = key;
  if (vars) el.dataset.i18nVars = JSON.stringify(vars);
  else delete el.dataset.i18nVars;
  el.textContent = t(key, vars);
}

// `aria-label` → `i18nAriaLabel`, the dataset name of `data-i18n-aria-label`. A dataset key can't keep the
// hyphen (setting `i18nAria-label` throws).
function datasetKey(attr: string) {
  return "i18n" + attr.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

export function setI18nAttribute(
  el: HTMLElement,
  attr: (typeof attributes)[number],
  key: string,
  vars?: Variables,
): void {
  el.dataset[datasetKey(attr)] = key;
  if (vars) el.dataset.i18nVars = JSON.stringify(vars);
  el.setAttribute(attr, t(key, vars));
}

export function onLanguageChange(listener: (language: Language) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLanguage(next: string): Language {
  language = next in catalogs ? next as Language : "en";
  document.documentElement.lang = language;
  applyTranslations();
  for (const listener of listeners) listener(language);
  return language;
}

onLanguageChange(() => applyTranslations());
