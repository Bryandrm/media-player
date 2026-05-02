//! Limpieza de metadata heurística para tracks descargados con yt-dlp.
//!
//! yt-dlp escribe la metadata desde lo que YouTube publica, que es a menudo
//! ruidoso:
//!   - artist viene como "Avicii - Topic" (canales auto-generados de YouTube
//!     Music) en vez de "Avicii".
//!   - title viene como "Avicii - The Nights (Lyric Video)" sin separar
//!     artista de título, o con sufijos tipo (Official Video).
//!
//! LRCLIB hace match exacto contra (artist, title), así que un sufijo de más
//! es suficiente para que devuelva 404 aunque el track esté ahí. Esta capa
//! corre antes del INSERT — la fila guardada queda con metadata limpia y
//! todas las queries futuras se benefician.
//!
//! La cleanup es **conservadora**: sólo strip-eamos patrones que claramente
//! son artefactos de YouTube, no contenido legítimo. Los falsos positivos
//! son peores que los falsos negativos — un track con título "Hello (cover)"
//! NO debería perder el "(cover)".

use super::TrackMetadata;

// Sufijos que limpiamos del campo `artist`. Match exacto al final.
// **Orden importa**: con `break` después del primer match, los patrones más
// largos/específicos van primero. Si "OfficialVEVO" estuviera después de
// "VEVO", "AviciiOfficialVEVO" matchearía "VEVO" primero y dejaría
// "AviciiOfficial" como artist — incorrecto.
//
// VEVO es una marca de YouTube — ningún artista real termina en VEVO,
// así que stripearlo sin espacio (`AviciiVEVO`) es seguro. Originalmente
// había sido conservador con esto pero los downloads vienen así seguido.
const ARTIST_NOISE_SUFFIXES: &[&str] = &[
    "OfficialVEVO",
    "OfficialChannel",
    "- Topic", // YouTube Music auto-generated channels (sin leading space —
    //            el `.trim()` defensivo lo remueve si lo había)
    " VEVO",
    " Vevo",
    "VEVO",
    "Vevo",
    " Official",
];

// Patrones a remover del campo `title`. Conservador: sólo casos clarísimos
// de "tag de upload" no contenido. Match case-insensitive.
const TITLE_NOISE_PATTERNS: &[&str] = &[
    // Variantes parentizadas — orden largo→corto para que el match más
    // específico gane (ej: "(Official Music Video)" antes que "(Official)").
    "(Official Music Video)",
    "(Official Lyric Video)",
    "(Official Audio Video)",
    "(Official Video)",
    "(Official Audio)",
    "(Official Visualizer)",
    "(Official Visualiser)",
    "(Official MV)",
    "(Lyric Video)",
    "(Lyric Visualizer)",
    "(Lyric Visualiser)",
    "(Lyrics Video)",
    "(Music Video)",
    "(Visualizer)",
    "(Visualiser)",
    "(Audio)",
    "(Lyrics)",
    "(MV)",
    "(HD)",
    "(HQ)",
    "(4K)",
    // Variantes con corchetes
    "[Official Music Video]",
    "[Official Video]",
    "[Official Audio]",
    "[Lyric Video]",
    "[Music Video]",
    "[Audio]",
    "[Lyrics]",
    "[MV]",
    "[HD]",
    "[HQ]",
    "[NCS Release]",
    "[NCS]",
    "[Free Download]",
    "[Free DL]",
    "[Monstercat Release]",
];

/// Aplica heurísticas para limpiar metadata extraída de archivos descargados
/// con yt-dlp. Idempotente: aplicarla dos veces no hace daño.
pub fn cleanup_metadata(mut meta: TrackMetadata) -> TrackMetadata {
    // 1. Limpiar artist: strip "- Topic" y similares.
    if let Some(artist) = meta.artist.as_mut() {
        // Defensive trim: yt-dlp a veces deja whitespace o chars invisibles
        // (BOM, zero-width space) al inicio/fin que rompen `strip_suffix`
        // sin que el usuario los vea en la UI.
        *artist = artist.trim().to_string();
        for suffix in ARTIST_NOISE_SUFFIXES {
            // Match case-sensitive porque los sufijos de YouTube tienen
            // casing canónico (`- Topic`, `VEVO`).
            if let Some(stripped) = artist.strip_suffix(suffix) {
                *artist = stripped.trim().to_string();
                break;
            }
        }
        // Si después de limpiar quedó vacío, marcamos None.
        if artist.trim().is_empty() {
            meta.artist = None;
        }
    }
    // Defensive trim del title también.
    meta.title = meta.title.trim().to_string();

    // 2. Limpiar title de sufijos ruidosos.
    meta.title = strip_title_noise(&meta.title);

    // 3. Si artist está vacío y title contiene " - ", asumimos formato
    //    "Artist - Title" típico de uploads sin tags. Splitamos en el primer
    //    separador. Heurística conservadora: sólo si artist vacío.
    let artist_missing = meta
        .artist
        .as_deref()
        .map_or(true, |a| a.trim().is_empty());
    if artist_missing {
        if let Some((maybe_artist, maybe_title)) = meta.title.split_once(" - ") {
            let a = maybe_artist.trim();
            let t = maybe_title.trim();
            if !a.is_empty() && !t.is_empty() {
                meta.artist = Some(a.to_string());
                meta.title = t.to_string();
            }
        }
    } else if let Some(artist_name) = meta.artist.as_deref() {
        // 4. Caso típico de yt-dlp: artist="Avicii", title="Avicii - The Nights".
        //    El título trae el prefijo del artista redundante. Si el title
        //    empieza con "<artist> - " (case-insensitive), strip-eamos el
        //    prefijo. Sólo cuando el artist está realmente al inicio — no
        //    rompe títulos como "Avicii Documentary" o "Tribute to Avicii".
        let lower_title = meta.title.to_lowercase();
        let lower_artist = artist_name.to_lowercase();
        let prefix = format!("{} - ", lower_artist);
        if lower_title.starts_with(&prefix) {
            // Strip por longitud de bytes — el casing del prefijo en el
            // title puede diferir del artist, pero la longitud byte-wise
            // coincide porque ambas son la misma string en lowercase.
            let stripped = meta.title[prefix.len()..].trim().to_string();
            if !stripped.is_empty() {
                meta.title = stripped;
            }
        }
    }

    meta
}

fn strip_title_noise(title: &str) -> String {
    let mut result = title.to_string();
    for pattern in TITLE_NOISE_PATTERNS {
        result = ci_remove_all(&result, pattern);
    }
    // Colapsar whitespace múltiple a uno solo y trim.
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Remueve todas las ocurrencias de `needle` en `haystack`, case-insensitive,
/// preservando el casing del resto del haystack.
fn ci_remove_all(haystack: &str, needle: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let lower_haystack = haystack.to_lowercase();
    let lower_needle = needle.to_lowercase();
    let mut result = String::with_capacity(haystack.len());
    let mut last_end = 0usize;
    let mut search_start = 0usize;
    while let Some(rel) = lower_haystack[search_start..].find(&lower_needle) {
        let abs_start = search_start + rel;
        let abs_end = abs_start + needle.len();
        result.push_str(&haystack[last_end..abs_start]);
        last_end = abs_end;
        search_start = abs_end;
    }
    result.push_str(&haystack[last_end..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(title: &str, artist: Option<&str>) -> TrackMetadata {
        TrackMetadata {
            title: title.to_string(),
            artist: artist.map(str::to_string),
            album: None,
            duration_ms: 0,
            track_number: None,
            year: None,
            genre: None,
            bitrate: None,
            sample_rate: None,
            format: None,
        }
    }

    #[test]
    fn strips_topic_suffix_from_artist() {
        let m = cleanup_metadata(meta("Wake Me Up", Some("Avicii - Topic")));
        assert_eq!(m.artist.as_deref(), Some("Avicii"));
    }

    #[test]
    fn strips_vevo_suffix_no_space() {
        // Caso real: yt-dlp escribe "MartinGarrixVEVO" como artist desde
        // el canal de YouTube. VEVO es marca de YouTube → safe stripear.
        let m = cleanup_metadata(meta("Animals", Some("MartinGarrixVEVO")));
        assert_eq!(m.artist.as_deref(), Some("MartinGarrix"));
    }

    #[test]
    fn strips_official_vevo() {
        // El caso del usuario: "AviciiOfficialVEVO" → "Avicii". Prueba que
        // el orden de patrones (OfficialVEVO antes que VEVO) funcione.
        let m = cleanup_metadata(meta("The Nights", Some("AviciiOfficialVEVO")));
        assert_eq!(m.artist.as_deref(), Some("Avicii"));
    }

    #[test]
    fn strips_space_vevo_suffix() {
        let m = cleanup_metadata(meta("Animals", Some("Martin Garrix VEVO")));
        assert_eq!(m.artist.as_deref(), Some("Martin Garrix"));
    }

    #[test]
    fn strips_artist_prefix_in_title() {
        // yt-dlp típicamente escribe title="Artist - Track" aunque artist
        // ya esté seteado. Eliminamos el prefijo redundante.
        let m = cleanup_metadata(meta("Avicii - The Nights", Some("Avicii")));
        assert_eq!(m.title, "The Nights");
        assert_eq!(m.artist.as_deref(), Some("Avicii"));
    }

    #[test]
    fn strips_artist_prefix_case_insensitive() {
        // El casing puede diferir: title="AVICII - The Nights", artist="Avicii".
        let m = cleanup_metadata(meta("AVICII - The Nights", Some("Avicii")));
        assert_eq!(m.title, "The Nights");
    }

    #[test]
    fn does_not_strip_when_artist_substring_only() {
        // "Tribute to Avicii" empieza con "T", no con "Avicii - " — safe.
        let m = cleanup_metadata(meta("Tribute to Avicii", Some("Avicii")));
        assert_eq!(m.title, "Tribute to Avicii");
    }

    #[test]
    fn full_youtube_style_cleanup() {
        // Caso completo del bug del usuario: artist+title sucios al estilo
        // típico de yt-dlp. Tras cleanup quedan limpios para LRCLIB.
        let m = cleanup_metadata(meta(
            "Avicii - The Nights (Official Video)",
            Some("AviciiOfficialVEVO"),
        ));
        assert_eq!(m.artist.as_deref(), Some("Avicii"));
        assert_eq!(m.title, "The Nights");
    }

    #[test]
    fn strips_official_video_from_title() {
        let m = cleanup_metadata(meta("The Nights (Official Video)", Some("Avicii")));
        assert_eq!(m.title, "The Nights");
    }

    #[test]
    fn strips_official_lyric_video() {
        let m = cleanup_metadata(meta("Wake Me Up (Official Lyric Video)", Some("Avicii")));
        assert_eq!(m.title, "Wake Me Up");
    }

    #[test]
    fn strips_brackets_hd() {
        let m = cleanup_metadata(meta("Levels [HD]", Some("Avicii")));
        assert_eq!(m.title, "Levels");
    }

    #[test]
    fn strips_ncs_release() {
        let m = cleanup_metadata(meta("On & On [NCS Release]", Some("Cartoon")));
        assert_eq!(m.title, "On & On");
    }

    #[test]
    fn case_insensitive_match() {
        let m = cleanup_metadata(meta("Hello (OFFICIAL VIDEO)", Some("Adele")));
        assert_eq!(m.title, "Hello");
    }

    #[test]
    fn extracts_artist_from_title_when_missing() {
        let m = cleanup_metadata(meta("Avicii - The Nights", None));
        assert_eq!(m.artist.as_deref(), Some("Avicii"));
        assert_eq!(m.title, "The Nights");
    }

    #[test]
    fn extracts_artist_from_title_when_empty() {
        let m = cleanup_metadata(meta("Avicii - Wake Me Up", Some("")));
        assert_eq!(m.artist.as_deref(), Some("Avicii"));
        assert_eq!(m.title, "Wake Me Up");
    }

    #[test]
    fn does_not_split_when_artist_present() {
        let m = cleanup_metadata(meta("X - Y", Some("RealArtist")));
        // Artist ya estaba presente, no tocamos el title splitting.
        assert_eq!(m.artist.as_deref(), Some("RealArtist"));
        assert_eq!(m.title, "X - Y");
    }

    #[test]
    fn combined_cleanup() {
        // Caso real típico: artist con "- Topic" + title con sufijo.
        let m = cleanup_metadata(meta(
            "The Nights (Official Lyric Video)",
            Some("Avicii - Topic"),
        ));
        assert_eq!(m.artist.as_deref(), Some("Avicii"));
        assert_eq!(m.title, "The Nights");
    }

    #[test]
    fn extract_then_strip() {
        // No artist, title formato "Artist - Title (Official Video)".
        let m = cleanup_metadata(meta("Avicii - The Nights (Official Video)", None));
        assert_eq!(m.artist.as_deref(), Some("Avicii"));
        assert_eq!(m.title, "The Nights");
    }

    #[test]
    fn preserves_legitimate_parens() {
        // "(cover)" no está en la lista de patrones — se conserva.
        let m = cleanup_metadata(meta("Hello (cover)", Some("SomeArtist")));
        assert_eq!(m.title, "Hello (cover)");
    }

    #[test]
    fn preserves_feat() {
        // "(feat. ...)" tampoco se borra.
        let m = cleanup_metadata(meta("Levitating (feat. DaBaby)", Some("Dua Lipa")));
        assert_eq!(m.title, "Levitating (feat. DaBaby)");
    }

    #[test]
    fn collapses_whitespace_after_strip() {
        // Después de strip-ear "(Official Video)", quedan espacios extras.
        let m = cleanup_metadata(meta(
            "The   Nights    (Official Video)",
            Some("Avicii"),
        ));
        assert_eq!(m.title, "The Nights");
    }

    #[test]
    fn idempotent() {
        // Aplicar dos veces no rompe.
        let once = cleanup_metadata(meta(
            "The Nights (Official Video)",
            Some("Avicii - Topic"),
        ));
        let twice = cleanup_metadata(once.clone());
        assert_eq!(once.title, twice.title);
        assert_eq!(once.artist, twice.artist);
    }

    #[test]
    fn empty_artist_after_strip_becomes_none() {
        // Artist con sólo "- Topic" después de strip queda vacío → None.
        let m = cleanup_metadata(meta("Track", Some(" - Topic")));
        assert_eq!(m.artist, None);
    }
}
