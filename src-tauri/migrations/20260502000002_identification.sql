-- Identification Fase 1: identificación canónica de audio vía AcoustID +
-- Chromaprint. Permite obtener un MBID de MusicBrainz para cada track,
-- usable como query exacto contra LRCLIB (track_mbid) y como verdad
-- canónica de title/artist (pisamos los originales que vienen sucios
-- desde yt-dlp, con backup en original_title/original_artist).
--
-- Aditivo — todas las columnas son nullable, los tracks existentes
-- siguen funcionando con identification_status = NULL ("nunca se intentó").
--
-- Ver docs/IDENTIFICATION.md §3.1.
--
-- SQLite no soporta `CHECK` añadido por `ALTER TABLE ADD COLUMN`. La
-- validación de identification_status ∈ {NULL, 'identified',
-- 'low_confidence', 'no_match', 'fingerprint_failed', 'api_error'} se
-- hace en código Rust al construir/persistir el resultado.

-- Fingerprint base64 de chromaprint. Se cachea para que un retry de la
-- llamada a AcoustID (status='api_error' → reintento) no requiera
-- re-correr fpcalc, que tarda 200-500ms por track.
ALTER TABLE tracks ADD COLUMN acoustid_fingerprint TEXT;

-- UUID propio de AcoustID. Distinto del MBID de MusicBrainz; útil sólo
-- si en el futuro queremos lookups directos a AcoustID por id (Fase 3).
ALTER TABLE tracks ADD COLUMN acoustid_id TEXT;

-- MBID de MusicBrainz (entidad `recording`, no release/artist/work).
-- Es la pieza clave: lo que LRCLIB acepta como query exacto vía
-- `?track_mbid=<uuid>` para devolver letras de **esa** grabación
-- específica, eliminando fuzzy match y drift por edición distinta.
ALTER TABLE tracks ADD COLUMN mbid_recording TEXT;

ALTER TABLE tracks ADD COLUMN identification_status TEXT;
ALTER TABLE tracks ADD COLUMN identification_attempted_at DATETIME;

-- Backup de la metadata original ANTES de pisarla con la canónica de
-- AcoustID. Se popula sólo cuando identification_status pasa a
-- 'identified' por primera vez y los valores canónicos difieren de los
-- actuales — si ya tenían valor previo (re-identify futuro), no se
-- sobreescribe. Permite revertir si el match resultó incorrecto.
ALTER TABLE tracks ADD COLUMN original_title TEXT;
ALTER TABLE tracks ADD COLUMN original_artist TEXT;

-- Lookup rápido por MBID — usado por el cascade de lyrics
-- (try_lrclib chequea primero `WHERE mbid_recording IS NOT NULL` para
-- preferir match exacto sobre text-based).
CREATE INDEX idx_tracks_mbid ON tracks(mbid_recording);

-- Filtrado por status para el bulk backfill de Fase 2:
-- `WHERE identification_status IS NULL OR identification_status = 'api_error'`.
CREATE INDEX idx_tracks_id_status ON tracks(identification_status);
