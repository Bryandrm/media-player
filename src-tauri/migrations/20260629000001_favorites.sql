-- Favoritos: flag por track + una smart playlist "FAVORITES" que los agrupa.
--
-- `tracks.is_favorite`: lo togglea la columna ★ de la LibraryTable (en toda
-- lista). `playlists.is_favorites`: marca la playlist built-in de favoritos —
-- es una smart playlist (is_smart=1) con la regla `is_favorite is 1`, pero el
-- frontend la trata especial (pin arriba, ★ en vez de ⚡, sin rename/delete/edit).
-- La membresía se deriva de la regla, así que togglear el flag la actualiza sola.

ALTER TABLE tracks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE playlists ADD COLUMN is_favorites INTEGER NOT NULL DEFAULT 0;
