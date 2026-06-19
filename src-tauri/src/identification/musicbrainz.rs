//! Cliente HTTP para MusicBrainz. Una sola request por track devuelve:
//!   - tags + genres → género (top tag filtrado)
//!   - releases + release-groups → year canónico (earliest first-release de
//!     un release-group tipo "Album") + nombre canónico del álbum
//!     + release-group MBID (para que Cover Art Archive lo use).
//!
//! Endpoint: `GET https://musicbrainz.org/ws/2/recording/{mbid}?inc=tags+genres+releases+release-groups&fmt=json`
//!
//! ## Tags vs genres (genre)
//!
//! MB expone dos colecciones distintas en cada recording:
//!   - `tags`: folksonomic, user-submitted. Con `count` (votos). Pueden ser
//!     géneros ("rock", "grunge") pero también décadas ("90s"), moods, ruido.
//!   - `genres`: subset curado, post-2018. Más limpio pero menor cobertura.
//!
//! Estrategia: preferir `genres`; caer a `tags` filtrados por stopwords.
//! Devolver el top por `count` lowercase.
//!
//! ## Releases (year + album)
//!
//! Un recording suele estar en N releases (singles, álbum, compilados,
//! soundtracks, ediciones especiales). Estrategia conservadora:
//!   1. Filtrar releases cuyo release-group sea de tipo "Album".
//!   2. Si hay → el más temprano (`first-release-date`) gana.
//!   3. Si no hay → caer al release-group más temprano de cualquier tipo
//!      (singles incluidos — para tracks que sólo existieron como single).
//!   4. Del release-group ganador, usar el `title` como album (canónico, sin
//!      info de edición) y el `first-release-date[..4]` como year.
//!
//! ## Rate limit
//!
//! MusicBrainz anonymous: 1 req/seg. User-Agent ya seteado en `lib.rs`. El
//! throttle entre requests lo maneja el caller del bulk backfill.

use serde::Deserialize;

use crate::errors::{AppError, AppResult};

const ENDPOINT_PREFIX: &str = "https://musicbrainz.org/ws/2/recording";

#[derive(Debug, Clone, Default)]
pub struct MbRecordingMetadata {
    /// Top genre lowercase (de tags+genres). `None` si no hay tags útiles.
    pub genre: Option<String>,
    /// Year del earliest first-release-date del release-group ganador.
    pub year: Option<i64>,
    /// Título del release-group ganador (sin "(Deluxe)" etc — versión limpia).
    pub album: Option<String>,
    /// MBID del release-group ganador. Lo usa Cover Art Archive para fetch
    /// del front cover. `None` si MB no tenía releases para esta recording.
    pub release_group_mbid: Option<String>,
}

#[derive(Deserialize)]
struct RawRecording {
    #[serde(default)]
    tags: Option<Vec<RawTag>>,
    #[serde(default)]
    genres: Option<Vec<RawTag>>,
    #[serde(default)]
    releases: Option<Vec<RawRelease>>,
}

#[derive(Deserialize)]
struct RawTag {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    count: Option<i64>,
}

#[derive(Deserialize)]
struct RawRelease {
    #[serde(default, rename = "release-group")]
    release_group: Option<RawReleaseGroup>,
}

#[derive(Deserialize, Clone)]
struct RawReleaseGroup {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: Option<String>,
    /// "Album" | "Single" | "EP" | "Compilation" | "Soundtrack" | etc. Puede
    /// faltar (release-group sin clasificar) — entonces None.
    #[serde(default, rename = "primary-type")]
    primary_type: Option<String>,
    /// "1991", "1991-09" o "1991-09-24". Vacío si MB no sabe.
    #[serde(default, rename = "first-release-date")]
    first_release_date: Option<String>,
}

/// Tags que NO son género — décadas, moods, ruido. Lista conservadora;
/// preferimos dejar pasar un mood ocasional que filtrar de más.
const TAG_STOPWORDS: &[&str] = &[
    "favorite", "favourites", "favorites", "lol", "nice", "good", "bad",
    "memories", "memory", "wishlist", "owned",
];

fn is_decade_tag(s: &str) -> bool {
    let trimmed = s.trim_end_matches('s');
    !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit())
}

/// Fetch completo de metadata por MBID. Devuelve un `MbRecordingMetadata` con
/// los campos que MB pudo resolver (cada uno puede ser `None` independiente).
/// 404 = recording borrada/mergeada → `Ok(default)`.
pub async fn fetch_recording_metadata(
    http: &reqwest::Client,
    mbid: &str,
) -> AppResult<MbRecordingMetadata> {
    let url = format!("{ENDPOINT_PREFIX}/{mbid}");

    let response = http
        .get(&url)
        .query(&[
            ("inc", "tags+genres+releases+release-groups"),
            ("fmt", "json"),
        ])
        .send()
        .await?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(MbRecordingMetadata::default());
    }
    if !response.status().is_success() {
        return Err(AppError::Other(format!(
            "musicbrainz {} for mbid {}",
            response.status(),
            mbid
        )));
    }

    let body = response.bytes().await?;
    parse_metadata(&body)
}

pub fn parse_metadata(body: &[u8]) -> AppResult<MbRecordingMetadata> {
    let raw: RawRecording = serde_json::from_slice(body)
        .map_err(|e| AppError::Other(format!("invalid mb response: {e}")))?;

    let genre = pick_genre(raw.tags, raw.genres);
    let (year, album, release_group_mbid) = pick_release(raw.releases);

    Ok(MbRecordingMetadata {
        genre,
        year,
        album,
        release_group_mbid,
    })
}

fn pick_genre(
    tags: Option<Vec<RawTag>>,
    genres: Option<Vec<RawTag>>,
) -> Option<String> {
    // 1) genres curados primero (más limpios).
    if let Some(list) = genres {
        if let Some(top) = top_tag(list) {
            return Some(top);
        }
    }
    // 2) Caer a tags filtrados.
    if let Some(list) = tags {
        if let Some(top) = top_tag(list) {
            return Some(top);
        }
    }
    None
}

fn top_tag(mut tags: Vec<RawTag>) -> Option<String> {
    tags.sort_by(|a, b| b.count.unwrap_or(0).cmp(&a.count.unwrap_or(0)));
    for t in tags {
        let Some(raw) = t.name else { continue };
        let name = raw.trim().to_ascii_lowercase();
        if name.is_empty() || TAG_STOPWORDS.contains(&name.as_str()) || is_decade_tag(&name) {
            continue;
        }
        return Some(name);
    }
    None
}

/// Selecciona el release-group "canónico" — el más temprano de tipo Album. Si
/// no hay álbumes (track que sólo existió como single), cae al earliest de
/// cualquier tipo. Devuelve (year, album_title, release_group_mbid).
fn pick_release(
    releases: Option<Vec<RawRelease>>,
) -> (Option<i64>, Option<String>, Option<String>) {
    let Some(releases) = releases else {
        return (None, None, None);
    };

    // Extraemos los release-groups distintos (un mismo release-group puede
    // aparecer en múltiples releases — ediciones repetidas). Dedup por id.
    let mut groups: Vec<RawReleaseGroup> = Vec::new();
    for r in releases {
        let Some(rg) = r.release_group else { continue };
        if rg.id.is_empty() {
            continue;
        }
        if !groups.iter().any(|g| g.id == rg.id) {
            groups.push(rg);
        }
    }

    if groups.is_empty() {
        return (None, None, None);
    }

    // Helper: convertir un release-group en una key sortable (Option<i64> de
    // year). Sin fecha → None; queda al final del sort ascendente.
    let year_of = |g: &RawReleaseGroup| -> Option<i64> {
        g.first_release_date.as_deref().and_then(parse_year)
    };

    // 1) Intentar entre los Albums.
    let mut albums: Vec<&RawReleaseGroup> = groups
        .iter()
        .filter(|g| matches!(g.primary_type.as_deref(), Some("Album")))
        .collect();
    albums.sort_by_key(|g| year_of(g).unwrap_or(i64::MAX));

    let winner = albums.first().copied().or_else(|| {
        // 2) Sin álbumes → cualquier tipo, earliest.
        let mut any: Vec<&RawReleaseGroup> = groups.iter().collect();
        any.sort_by_key(|g| year_of(g).unwrap_or(i64::MAX));
        any.first().copied()
    });

    match winner {
        None => (None, None, None),
        Some(g) => {
            let year = year_of(g);
            let album = g.title.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            let mbid = if g.id.is_empty() { None } else { Some(g.id.clone()) };
            (year, album, mbid)
        }
    }
}

/// Parsea el año de las primeras 4 chars de un date MB ("1991-09-24",
/// "1991-09", "1991"). Filtro de sanidad 1900..=2100 — MB a veces tiene
/// "0000" o fechas placeholder.
fn parse_year(date: &str) -> Option<i64> {
    let trimmed = date.trim();
    if trimmed.len() < 4 {
        return None;
    }
    let y: i64 = trimmed.get(..4)?.parse().ok()?;
    if (1900..=2100).contains(&y) {
        Some(y)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_top_genre_when_available() {
        let json = br#"{
            "genres": [
                {"name": "Grunge", "count": 8},
                {"name": "Rock", "count": 3}
            ],
            "tags": [{"name": "90s", "count": 12}]
        }"#;
        let m = parse_metadata(json).unwrap();
        assert_eq!(m.genre, Some("grunge".to_string()));
    }

    #[test]
    fn falls_back_to_tags_when_no_genres() {
        let json = br#"{
            "genres": [],
            "tags": [
                {"name": "Electronic", "count": 5},
                {"name": "Trance", "count": 3}
            ]
        }"#;
        assert_eq!(
            parse_metadata(json).unwrap().genre,
            Some("electronic".to_string())
        );
    }

    #[test]
    fn filters_decade_and_stopwords() {
        let json = br#"{
            "tags": [
                {"name": "favorite", "count": 20},
                {"name": "90s", "count": 15},
                {"name": "post-rock", "count": 4}
            ]
        }"#;
        assert_eq!(
            parse_metadata(json).unwrap().genre,
            Some("post-rock".to_string())
        );
    }

    #[test]
    fn picks_earliest_album_release_group() {
        // Un single de 1991 y un álbum de 1992 (re-release del mismo single).
        // El álbum debería ganar aunque sea posterior.
        let json = br#"{
            "releases": [
                {
                    "release-group": {
                        "id": "single-rg",
                        "title": "Smells Like Teen Spirit",
                        "primary-type": "Single",
                        "first-release-date": "1991-09-10"
                    }
                },
                {
                    "release-group": {
                        "id": "album-rg",
                        "title": "Nevermind",
                        "primary-type": "Album",
                        "first-release-date": "1991-09-24"
                    }
                },
                {
                    "release-group": {
                        "id": "comp-rg",
                        "title": "Best Of",
                        "primary-type": "Compilation",
                        "first-release-date": "2002-10-29"
                    }
                }
            ]
        }"#;
        let m = parse_metadata(json).unwrap();
        assert_eq!(m.year, Some(1991));
        assert_eq!(m.album, Some("Nevermind".to_string()));
        assert_eq!(m.release_group_mbid, Some("album-rg".to_string()));
    }

    #[test]
    fn falls_back_to_any_release_when_no_albums() {
        let json = br#"{
            "releases": [
                {
                    "release-group": {
                        "id": "single-rg",
                        "title": "Standalone Single",
                        "primary-type": "Single",
                        "first-release-date": "2018-05-04"
                    }
                }
            ]
        }"#;
        let m = parse_metadata(json).unwrap();
        assert_eq!(m.year, Some(2018));
        assert_eq!(m.album, Some("Standalone Single".to_string()));
    }

    #[test]
    fn handles_release_group_without_date() {
        let json = br#"{
            "releases": [
                {
                    "release-group": {
                        "id": "rg",
                        "title": "Album Without Date",
                        "primary-type": "Album"
                    }
                }
            ]
        }"#;
        let m = parse_metadata(json).unwrap();
        assert_eq!(m.year, None);
        assert_eq!(m.album, Some("Album Without Date".to_string()));
        assert_eq!(m.release_group_mbid, Some("rg".to_string()));
    }

    #[test]
    fn deduplicates_repeated_release_groups() {
        // Dos releases del mismo release-group (vinyl y CD del mismo álbum).
        // No deberíamos contarlo dos veces — solo una vez.
        let json = br#"{
            "releases": [
                {"release-group": {"id": "rg", "title": "A", "primary-type": "Album", "first-release-date": "2000"}},
                {"release-group": {"id": "rg", "title": "A", "primary-type": "Album", "first-release-date": "2000"}}
            ]
        }"#;
        let m = parse_metadata(json).unwrap();
        assert_eq!(m.album, Some("A".to_string()));
    }

    #[test]
    fn parses_partial_dates() {
        assert_eq!(parse_year("1991"), Some(1991));
        assert_eq!(parse_year("1991-09"), Some(1991));
        assert_eq!(parse_year("1991-09-24"), Some(1991));
        assert_eq!(parse_year(""), None);
        assert_eq!(parse_year("0000"), None);
        assert_eq!(parse_year("9999"), None);
    }

    #[test]
    fn empty_response_returns_all_none() {
        let json = br#"{}"#;
        let m = parse_metadata(json).unwrap();
        assert!(m.genre.is_none());
        assert!(m.year.is_none());
        assert!(m.album.is_none());
        assert!(m.release_group_mbid.is_none());
    }
}
