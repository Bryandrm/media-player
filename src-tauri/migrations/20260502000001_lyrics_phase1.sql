-- Lyrics Fase 1: extender la tabla `lyrics` existente con columnas para
-- offset ajustable por usuario, status (found/not_found/manual_pending),
-- y tracking del provider que respondió. Aditivo — no rompe filas
-- existentes (la tabla está vacía hoy, pero el patrón vale para futuras
-- migraciones).
--
-- Ver docs/LYRICS.md §4.2.
--
-- SQLite no soporta `CHECK` añadido por `ALTER TABLE ADD COLUMN`. La
-- validación de status ∈ {'found','not_found','manual_pending'} se hace en
-- código Rust al construir el Lyrics.

ALTER TABLE lyrics ADD COLUMN offset_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lyrics ADD COLUMN status TEXT NOT NULL DEFAULT 'found';
ALTER TABLE lyrics ADD COLUMN source_id TEXT;
ALTER TABLE lyrics ADD COLUMN confidence REAL;
ALTER TABLE lyrics ADD COLUMN last_used_at DATETIME;

CREATE INDEX idx_lyrics_status ON lyrics(status);
