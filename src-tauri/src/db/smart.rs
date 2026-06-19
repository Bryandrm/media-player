//! Evaluación de smart playlists: parsea el JSON de reglas y arma un SELECT
//! dinámico sobre `tracks`. La membresía de una smart playlist no se guarda en
//! `playlist_tracks` — se recalcula corriendo esta query cada vez.
//!
//! Seguridad: los nombres de columna salen de un `match` contra literales
//! conocidos (whitelist) y los valores SIEMPRE van por bind (`push_bind`),
//! nunca interpolados. Aunque el JSON venga del usuario no hay superficie de
//! inyección. Una condición con field/op no soportado o un valor numérico que
//! no parsea se descarta silenciosamente; si no queda ninguna condición válida
//! la query devuelve 0 filas (`WHERE 1=0`) en vez de toda la library.

use serde::Deserialize;
use sqlx::{QueryBuilder, Sqlite};

/// Reglas de una smart playlist, deserializadas de la columna `rules`.
#[derive(Debug, Deserialize)]
pub struct SmartRules {
    /// "all" → condiciones unidas por AND; "any" → por OR. Default "all".
    #[serde(default = "default_match", rename = "match")]
    pub match_mode: String,
    #[serde(default)]
    pub conditions: Vec<Condition>,
}

#[derive(Debug, Deserialize)]
pub struct Condition {
    pub field: String,
    pub op: String,
    pub value: String,
}

fn default_match() -> String {
    "all".to_string()
}

/// Columnas + JOIN de lyrics, idénticas al shape de `tracks::list_all` para que
/// el frontend reuse la misma `LibraryTable`. (Se repite a propósito en vez de
/// abstraer un helper genérico — mismo criterio que list_all vs list_tracks.)
const TRACKS_SELECT: &str = "SELECT t.id, t.file_path, t.title, t.artist, t.album, \
        t.duration_ms, t.track_number, t.year, t.genre, t.format, t.cover_art_path, \
        CASE \
            WHEN l.track_id IS NULL THEN NULL \
            WHEN l.status = 'not_found' THEN 'not_found' \
            WHEN l.synced_lyrics IS NOT NULL THEN 'synced' \
            WHEN l.plain_lyrics IS NOT NULL THEN 'plain' \
            ELSE 'instrumental' \
        END AS lyrics_status, \
        t.acoustid_id, t.mbid_recording, t.identification_status, t.acoustid_score \
     FROM tracks t \
     LEFT JOIN lyrics l ON l.track_id = t.id";

/// Query que devuelve los tracks que matchean las reglas, ordenados por título.
pub fn build_tracks_query(rules: &SmartRules) -> QueryBuilder<'_, Sqlite> {
    let mut qb = QueryBuilder::new(TRACKS_SELECT);
    append_where(&mut qb, rules);
    qb.push(" ORDER BY t.title COLLATE NOCASE");
    qb
}

/// Query que cuenta los tracks que matchean (para el badge del sidebar).
pub fn build_count_query(rules: &SmartRules) -> QueryBuilder<'_, Sqlite> {
    let mut qb = QueryBuilder::new("SELECT COUNT(*) FROM tracks t");
    append_where(&mut qb, rules);
    qb
}

fn append_where(qb: &mut QueryBuilder<Sqlite>, rules: &SmartRules) {
    let valid: Vec<&Condition> = rules
        .conditions
        .iter()
        .filter(|c| is_supported(&c.field, &c.op, &c.value))
        .collect();
    if valid.is_empty() {
        qb.push(" WHERE 1=0");
        return;
    }
    let joiner = if rules.match_mode == "any" { " OR " } else { " AND " };
    qb.push(" WHERE ");
    for (i, c) in valid.iter().enumerate() {
        if i > 0 {
            qb.push(joiner);
        }
        append_condition(qb, c);
    }
}

/// ¿Es una combinación field+op (y valor, para numéricos/fecha) que sabemos
/// traducir a SQL? Se usa para filtrar condiciones inválidas antes de armar la
/// query — así una sola condición rota no tumba toda la playlist.
fn is_supported(field: &str, op: &str, value: &str) -> bool {
    match field {
        "title" | "artist" | "album" | "genre" => {
            matches!(op, "is" | "is_not" | "contains" | "not_contains")
        }
        "year" | "play_count" => {
            matches!(op, "is" | "gt" | "lt" | "gte" | "lte") && value.trim().parse::<i64>().is_ok()
        }
        "added_within_days" | "played_within_days" => value.trim().parse::<i64>().is_ok(),
        _ => false,
    }
}

fn append_condition(qb: &mut QueryBuilder<Sqlite>, c: &Condition) {
    match c.field.as_str() {
        "title" | "artist" | "album" | "genre" => {
            // El nombre de columna es uno de los literales del match → seguro.
            let col = c.field.as_str();
            match c.op.as_str() {
                "is" => {
                    qb.push("t.").push(col).push(" = ").push_bind(c.value.clone());
                    qb.push(" COLLATE NOCASE");
                }
                "is_not" => {
                    qb.push("t.").push(col).push(" <> ").push_bind(c.value.clone());
                    qb.push(" COLLATE NOCASE");
                }
                "contains" => {
                    qb.push("t.")
                        .push(col)
                        .push(" LIKE ")
                        .push_bind(format!("%{}%", c.value));
                }
                "not_contains" => {
                    qb.push("t.")
                        .push(col)
                        .push(" NOT LIKE ")
                        .push_bind(format!("%{}%", c.value));
                }
                _ => {
                    qb.push("1=0");
                }
            }
        }
        "year" | "play_count" => {
            let col = c.field.as_str();
            // is_supported ya garantizó que parsea.
            let n: i64 = c.value.trim().parse().unwrap_or(0);
            let sql_op = match c.op.as_str() {
                "is" => "=",
                "gt" => ">",
                "lt" => "<",
                "gte" => ">=",
                "lte" => "<=",
                _ => "=",
            };
            qb.push("t.")
                .push(col)
                .push(" ")
                .push(sql_op)
                .push(" ")
                .push_bind(n);
        }
        "added_within_days" | "played_within_days" => {
            let col = if c.field == "added_within_days" {
                "added_at"
            } else {
                "last_played_at"
            };
            let n: i64 = c.value.trim().parse().unwrap_or(0);
            // `datetime('now', '-N days')` acotando hacia atrás. El bind es el
            // modificador completo, no sólo el número.
            qb.push("t.")
                .push(col)
                .push(" >= datetime('now', ")
                .push_bind(format!("-{n} days"))
                .push(")");
        }
        _ => {
            qb.push("1=0");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(match_mode: &str, conds: &[(&str, &str, &str)]) -> SmartRules {
        SmartRules {
            match_mode: match_mode.to_string(),
            conditions: conds
                .iter()
                .map(|(f, o, v)| Condition {
                    field: f.to_string(),
                    op: o.to_string(),
                    value: v.to_string(),
                })
                .collect(),
        }
    }

    // Inspeccionamos el SQL generado (sin tocar la DB). Los valores van por bind
    // (`?`), nunca interpolados — eso es lo que confirma que no hay inyección.
    fn sql(r: &SmartRules) -> String {
        build_tracks_query(r).sql().to_string()
    }

    #[test]
    fn text_is_uses_bind_and_nocase() {
        let s = sql(&rules("all", &[("genre", "is", "Rock")]));
        assert!(s.contains("t.genre = ?"), "{s}");
        assert!(s.contains("COLLATE NOCASE"), "{s}");
        // El valor del usuario NUNCA aparece literal en el SQL.
        assert!(!s.contains("Rock"), "{s}");
    }

    #[test]
    fn match_any_joins_with_or() {
        let s = sql(&rules(
            "any",
            &[("artist", "is", "A"), ("artist", "is", "B")],
        ));
        assert!(s.contains(" OR "), "{s}");
        assert!(!s.contains(" AND "), "{s}");
    }

    #[test]
    fn match_all_joins_with_and() {
        let s = sql(&rules(
            "all",
            &[("genre", "is", "Rock"), ("year", "gt", "2010")],
        ));
        assert!(s.contains(" AND "), "{s}");
        assert!(s.contains("t.year > ?"), "{s}");
    }

    #[test]
    fn days_uses_datetime_modifier_bind() {
        let s = sql(&rules("all", &[("added_within_days", "is", "30")]));
        assert!(s.contains("t.added_at >= datetime('now', ?)"), "{s}");
    }

    #[test]
    fn invalid_conditions_are_dropped_to_no_match() {
        // Campo desconocido + numérico no parseable → ninguna condición válida.
        let s = sql(&rules(
            "all",
            &[("bogus", "is", "x"), ("year", "gt", "notanumber")],
        ));
        assert!(s.contains("WHERE 1=0"), "{s}");
    }

    #[test]
    fn mixed_valid_and_invalid_keeps_only_valid() {
        let s = sql(&rules(
            "all",
            &[("year", "gt", "notanumber"), ("genre", "contains", "jazz")],
        ));
        assert!(s.contains("t.genre LIKE ?"), "{s}");
        // `t.year` aparece en la lista de columnas del SELECT, pero NO debe
        // aparecer como predicado en el WHERE (la condición numérica era inválida).
        assert!(!s.contains("t.year >"), "{s}");
    }
}
