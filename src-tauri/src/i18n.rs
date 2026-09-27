// DECISION: The shared catalogs provide app text, so CFBundleLocalizations is enough; no empty .lproj bundles are needed.
use std::{collections::HashMap, sync::{OnceLock, RwLock}};

type Catalog = HashMap<String, String>;

static LANGUAGE: OnceLock<RwLock<&'static str>> = OnceLock::new();
static CATALOGS: OnceLock<HashMap<&'static str, Catalog>> = OnceLock::new();

fn language_state() -> &'static RwLock<&'static str> {
  LANGUAGE.get_or_init(|| RwLock::new("en"))
}

fn catalogs() -> &'static HashMap<&'static str, Catalog> {
  CATALOGS.get_or_init(|| {
    [
      ("en", include_str!("../../src/shared/i18n/en.json")),
      ("zh-Hant", include_str!("../../src/shared/i18n/zh-Hant.json")),
      ("zh-Hans", include_str!("../../src/shared/i18n/zh-Hans.json")),
      ("ja", include_str!("../../src/shared/i18n/ja.json")),
    ].into_iter().map(|(language, text)| {
      (language, serde_json::from_str::<Catalog>(text).expect("valid localization catalog"))
    }).collect()
  })
}

pub fn set_language(language: &str) {
  let resolved = match language {
    "zh-Hant" | "zh-Hans" | "ja" => language,
    _ => "en",
  };
  *language_state().write().unwrap() = match resolved {
    "zh-Hant" => "zh-Hant",
    "zh-Hans" => "zh-Hans",
    "ja" => "ja",
    _ => "en",
  };
}

pub fn current_language() -> &'static str {
  *language_state().read().unwrap()
}

pub fn t(key: &str) -> String {
  let lang = current_language();
  catalogs().get(lang).and_then(|c| c.get(key))
    .or_else(|| catalogs().get("en").and_then(|c| c.get(key)))
    .cloned().unwrap_or_else(|| key.to_string())
}

pub fn t_with(key: &str, vars: &[(&str, &str)]) -> String {
  let mut text = t(key);
  for (name, value) in vars {
    text = text.replace(&format!("{{{name}}}"), value);
  }
  text
}

#[cfg(test)]
mod tests {
  use std::collections::{BTreeMap, BTreeSet};

  const INCOMPLETE_TRANSLATION_ALLOWLIST: &[(&str, &str)] = &[];

  fn catalogs() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
      ("en", include_str!("../../src/shared/i18n/en.json")),
      ("zh-Hant", include_str!("../../src/shared/i18n/zh-Hant.json")),
      ("zh-Hans", include_str!("../../src/shared/i18n/zh-Hans.json")),
      ("ja", include_str!("../../src/shared/i18n/ja.json")),
    ])
  }

  fn placeholders(text: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
      let after = &rest[start + 1..];
      let Some(end) = after.find('}') else { break };
      found.insert(after[..end].to_string());
      rest = &rest[start + end + 2..];
    }
    found
  }

  #[test]
  fn language_catalogs_match_english_keys_and_placeholders() {
    let catalogs = catalogs().into_iter().map(|(lang, text)| {
      (lang, serde_json::from_str::<BTreeMap<String, String>>(text).unwrap())
    }).collect::<BTreeMap<_, _>>();
    let english = &catalogs["en"];
    for (language, catalog) in &catalogs {
      for key in catalog.keys() {
        assert!(english.contains_key(key), "{language} has extra key {key}");
      }
      for key in english.keys() {
        if !catalog.contains_key(key) {
          assert!(INCOMPLETE_TRANSLATION_ALLOWLIST.contains(&(*language, key.as_str())), "{language} is missing {key}");
        }
      }
      for (key, value) in catalog {
        if let Some(source) = english.get(key) {
          assert_eq!(placeholders(source), placeholders(value), "placeholder mismatch in {language}:{key}");
        }
      }
      assert!(catalog["error.document.unmappable"].starts_with(crate::documents::UNMAPPABLE), "{language} changed the machine prefix");
    }
  }

  #[test]
  fn every_command_has_a_catalog_label() {
    let commands: serde_json::Value = serde_json::from_str(include_str!("../../src/shared/commands.json")).unwrap();
    let english: BTreeMap<String, String> = serde_json::from_str(include_str!("../../src/shared/i18n/en.json")).unwrap();
    for command in commands.as_array().unwrap() {
      let id = command["id"].as_str().unwrap();
      assert!(english.contains_key(&format!("command.{id}")), "missing label for command {id}");
    }
  }
}
