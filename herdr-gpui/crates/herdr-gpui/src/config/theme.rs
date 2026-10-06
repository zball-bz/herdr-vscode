//! Terminal and chrome colors: built-in palettes, Ghostty theme files, and
//! where they are found.
use super::{Config, config_root, home};
use crate::{Error, Result, error::ThemeParseError};
pub use herdr_pane_view::theme::{Theme, mix};
use std::{
    env, fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};

const FOLLOW_HERDR: &str = "Follow Herdr";

/// A `theme` value: one theme, or Ghostty's `light:NAME,dark:NAME`, which
/// follows the system appearance. Either side may itself be a built-in, file,
/// path, or `Follow Herdr`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ThemeName<'a> {
    Single(&'a str),
    System { light: &'a str, dark: &'a str },
}

impl<'a> ThemeName<'a> {
    pub(crate) fn parse(value: &'a str) -> Result<Self> {
        let value = value.trim();
        let side = |part: &'a str| {
            let part = part.trim();
            part.strip_prefix("light:")
                .map(|name| (true, name.trim()))
                .or_else(|| part.strip_prefix("dark:").map(|name| (false, name.trim())))
        };
        if side(value).is_none() {
            return Ok(Self::Single(value));
        }
        let mut parts = value.split(',');
        match (
            parts.next().and_then(side),
            parts.next().and_then(side),
            parts.next(),
        ) {
            (Some((true, light)), Some((false, dark)), None)
            | (Some((false, dark)), Some((true, light)), None)
                if !light.is_empty() && !dark.is_empty() =>
            {
                Ok(Self::System { light, dark })
            }
            _ => Err(Error::InvalidThemePair),
        }
    }

    /// The theme shown for the given system appearance.
    pub(crate) fn get(self, light: bool) -> &'a str {
        match self {
            Self::Single(name) => name,
            Self::System { light: name, .. } if light => name,
            Self::System { dark, .. } => dark,
        }
    }

    /// The name `value` shows for `light`, or `value` itself when invalid.
    pub(crate) fn side(value: &str, light: bool) -> &str {
        ThemeName::parse(value).map_or(value, |name| name.get(light))
    }

    pub(crate) fn follows_system(value: &str) -> bool {
        matches!(ThemeName::parse(value), Ok(ThemeName::System { .. }))
    }

    /// `value` with the side for `light` replaced by `name`. A single theme
    /// is replaced outright.
    pub(crate) fn with_side(value: &str, light: bool, name: &str) -> String {
        match ThemeName::parse(value) {
            Ok(ThemeName::System { dark, .. }) if light => Self::system(name, dark),
            Ok(ThemeName::System { light, .. }) => Self::system(light, name),
            _ => name.into(),
        }
    }

    pub(crate) fn system(light: &str, dark: &str) -> String {
        format!("light:{light},dark:{dark}")
    }
}

fn theme_directories() -> Result<Vec<PathBuf>> {
    let root = config_root()?;
    let mut directories = vec![root.join("herdr/themes"), root.join("ghostty/themes")];
    if let Some(resources) = env::var_os("GHOSTTY_RESOURCES_DIR").filter(|value| !value.is_empty())
    {
        directories.push(PathBuf::from(resources).join("themes"));
    }
    directories.push(PathBuf::from(
        "/Applications/Ghostty.app/Contents/Resources/ghostty/themes",
    ));
    if let Some(data) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        directories.push(PathBuf::from(data).join("ghostty/themes"));
    } else if let Ok(home) = home() {
        directories.push(home.join(".local/share/ghostty/themes"));
    }
    let data_dirs = env::var_os("XDG_DATA_DIRS")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    directories.extend(env::split_paths(&data_dirs).map(|dir| dir.join("ghostty/themes")));
    Ok(directories)
}

impl Config {
    /// Discover names without parsing every theme. On failure, callers can use
    /// `Theme::BUILTIN_NAMES`, which remain loadable without any directories.
    pub fn available_themes(&self) -> Result<Vec<String>> {
        self.available_themes_in(&theme_directories()?)
    }

    pub(super) fn available_themes_in(&self, directories: &[PathBuf]) -> Result<Vec<String>> {
        let mut names: Vec<String> = Theme::BUILTIN_NAMES
            .iter()
            .copied()
            .chain([FOLLOW_HERDR])
            .map(str::to_owned)
            .collect();
        for directory in directories {
            let entries = match fs::read_dir(directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(Error::from(error).at_path(directory)),
            };
            for entry in entries {
                let entry = entry.map_err(|error| Error::from(error).at_path(directory))?;
                // Follow symlinks just as the named theme loader does.
                let metadata = match fs::metadata(entry.path()) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == ErrorKind::NotFound => continue,
                    Err(error) => return Err(Error::from(error).at_path(&entry.path())),
                };
                if metadata.is_file()
                    && let Some(name) = entry.file_name().to_str()
                {
                    names.push(name.to_owned());
                }
            }
        }
        let selected = ThemeName::parse(&self.theme).unwrap_or(ThemeName::Single(&self.theme));
        for selected in [selected.get(true), selected.get(false)] {
            if Path::new(selected).is_absolute() || selected.starts_with("~/") {
                names.push(selected.to_owned());
            }
        }
        names.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
        names.dedup();
        Ok(names)
    }

    /// The theme for the system appearance: `light` picks a side of a
    /// `light:…,dark:…` value, and Herdr's light palette for `Follow Herdr`.
    pub fn theme(&self, light: bool) -> Result<Theme> {
        self.theme_with_directories(light, theme_directories)
            .map(|theme| theme.with_contrast(self.contrast))
    }

    /// Resolves every side, so a pair is refused before it is saved rather
    /// than when the system next changes appearance.
    pub(crate) fn validate_theme(&self) -> Result<()> {
        if ThemeName::follows_system(&self.theme) {
            self.theme(true)?;
        }
        self.theme(false).map(drop)
    }

    pub(super) fn theme_with_directories(
        &self,
        light: bool,
        directories: impl FnOnce() -> Result<Vec<PathBuf>>,
    ) -> Result<Theme> {
        let name = ThemeName::parse(&self.theme)?.get(light);
        if name == FOLLOW_HERDR {
            return crate::herdr_settings::Settings::load()?.theme(light);
        }
        if let Some(theme) = Theme::builtin(name) {
            return Ok(theme);
        }
        let path = if let Some(relative) = name.strip_prefix("~/") {
            home()?.join(relative)
        } else if Path::new(name).is_absolute() {
            PathBuf::from(name)
        } else {
            if name.is_empty()
                || Path::new(name).components().count() != 1
                || !matches!(
                    Path::new(name).components().next(),
                    Some(Component::Normal(_))
                )
            {
                return Err(Error::InvalidThemePath);
            }
            let directories = directories()?;
            let mut found = None;
            for directory in &directories {
                let candidate = directory.join(name);
                match fs::metadata(&candidate) {
                    Ok(metadata) if metadata.is_file() => {
                        found = Some(candidate);
                        break;
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == ErrorKind::NotFound => {}
                    Err(error) => return Err(Error::from(error).at_path(&candidate)),
                }
            }
            found.ok_or_else(|| Error::ThemeNotFound {
                name: name.into(),
                directories,
            })?
        };
        let text = fs::read_to_string(&path).map_err(|error| Error::from(error).at_path(&path))?;
        parse_ghostty(&text).map_err(|error| error.at_path(&path))
    }
}

/// A Ghostty theme file's colors. Includes, commands, and unrelated settings are
/// never interpreted.
pub(super) fn parse_ghostty(text: &str) -> Result<Theme> {
    let mut theme = Theme::default();
    let mut cursor_set = false;
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line.split_once('=').unwrap_or((line, ""));
        let key = key.trim();
        let value = value.trim();
        let error = |source| Error::ThemeLine {
            line: index + 1,
            key: key.into(),
            source,
        };
        let color = |value: &str| -> Result<u32> {
            let hex = value.strip_prefix('#').unwrap_or(value);
            if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(error(ThemeParseError::InvalidColor));
            }
            u32::from_str_radix(hex, 16)
                .map_err(|source| error(ThemeParseError::InvalidHex(source)))
        };
        match key {
            "background" => theme.background = color(value)?,
            "foreground" => theme.foreground = color(value)?,
            "cursor-color" => {
                theme.cursor = color(value)?;
                cursor_set = true;
            }
            "palette" => {
                let (index, value) = value
                    .split_once('=')
                    .ok_or_else(|| error(ThemeParseError::MissingPaletteColor))?;
                let index = index
                    .trim()
                    .parse::<usize>()
                    .map_err(|source| error(ThemeParseError::InvalidPaletteIndex(source)))?;
                if index >= 256 {
                    return Err(error(ThemeParseError::PaletteIndexOutOfRange));
                }
                theme.palette[index] = color(value.trim())?;
            }
            _ => {} // Never interpret includes, commands, or unrelated Ghostty settings.
        }
    }
    if !cursor_set {
        theme.cursor = theme.foreground;
    }
    theme.derive_chrome();
    Ok(theme)
}
